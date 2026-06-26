#!/usr/bin/env python3
"""Realtime chain-event streamer (#1361, epic #1345) — Option B.

A long-running service: subscribes to FINALIZED finney heads and, for each new
block, decodes its SubtensorModule events with the EXACT verified extractors from
fetch-events.py (imported, not duplicated — no drift) and POSTs them to the
Worker's authenticated ingest endpoint (#1360). End-to-end latency ~12-30s (one
block). The #1346 CI poller stays running as a self-healing backstop; inserts are
idempotent on (block_number, event_index), so any overlap — or a dropped block —
is covered for free.

Production behavior:
  * Structured, leveled logging (timestamp + level). The per-block line is DEBUG
    (quiet by default); a periodic INFO summary shows liveness without flooding.
  * A failed ingest POST is logged + skipped (the poller backstop covers it) — it
    does NOT tear down the subscription.
  * Exponential backoff + jitter on RPC reconnect; SIGTERM/SIGINT graceful stop.

Deployed on Railway (config-as-code via railway.json); see docs/realtime-streamer.md.

Run:
  EVENTS_INGEST_URL=https://api.metagraph.sh/api/v1/internal/events \
  METAGRAPH_EVENTS_INGEST_SECRET=... \
  uv run --with substrate-interface==1.8.1 python scripts/stream-events.py
Env knobs: LOG_LEVEL (default INFO), EVENTS_SUMMARY_EVERY_BLOCKS (default 20).
"""
import importlib.util
import json
import logging
import os
import random
import signal
import ssl
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import urlparse

from substrateinterface import SubstrateInterface

RPC = os.environ.get("EVENTS_RPC_URL", "wss://entrypoint-finney.opentensor.ai:443")
INGEST_URL = os.environ.get("EVENTS_INGEST_URL")
# Block-explorer ingest (#1345 Option B) — same host as the events endpoint, so it
# is derived: only EVENTS_INGEST_URL must be set (overridable for odd routings).
BLOCKS_INGEST_URL = os.environ.get("BLOCKS_INGEST_URL") or (
    INGEST_URL.replace("/internal/events", "/internal/blocks")
    if INGEST_URL
    else None
)
SECRET = os.environ.get("METAGRAPH_EVENTS_INGEST_SECRET")
TOKEN_HEADER = "x-metagraph-events-token"
PUSH_TIMEOUT = 15
SUMMARY_EVERY = max(1, int(os.environ.get("EVENTS_SUMMARY_EVERY_BLOCKS", "20")))
MAX_BACKOFF = 60

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%SZ",
    stream=sys.stdout,
)
log = logging.getLogger("streamer")

# Reuse the EXACT verified decode from fetch-events.py (hyphenated → load by path).
_FE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fetch-events.py")
_spec = importlib.util.spec_from_file_location("fetch_events", _FE_PATH)
_fe = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_fe)
extract = _fe.extract

# Block-explorer realtime (#1345 Option B): besides account_events, each finalized
# head also emits its `blocks` row + `extrinsics` rows (via _fe.block_extras +
# _fe.extrinsics_for_block) POSTed to /api/v1/internal/blocks. This closes the
# blocks/extrinsics realtime gap the coalesced CI poller alone left (~58%; #1749);
# the CI poller stays the self-healing backstop and INSERT OR IGNORE on the PKs
# makes the overlap free.

_stop = False


def _handle_signal(signum, _frame):
    global _stop
    _stop = True
    log.info("received signal %s — shutting down gracefully", signum)


signal.signal(signal.SIGTERM, _handle_signal)
signal.signal(signal.SIGINT, _handle_signal)


def decode_head(s, block_number):
    """Decode one finalized block → account_events + block/extrinsic rows (#1345 B).

    Returns {"events": [...], "block": {...}|None, "extrinsics": [...]}.
    """
    block_hash = s.get_block_hash(block_number)
    # Read the block's timestamp AT THIS block_hash. Querying Timestamp.Now
    # without a block_hash resolves at the chain's current best block, which
    # leads the finalized head being processed by ~2-3 blocks — skewing every
    # event's observed_at into the future (and mis-binning events near a UTC-day
    # boundary). The events query below already pins block_hash; the timestamp
    # must use the same one.
    try:
        head_ts = int(s.query("Timestamp", "Now", block_hash=block_hash).value)
    except Exception:
        head_ts = None
    events = s.query("System", "Events", block_hash=block_hash)
    event_rows = []
    for event_index, ev in enumerate(events):
        v = ev.value if isinstance(ev.value, dict) else {}
        e = v.get("event", {}) if isinstance(v.get("event"), dict) else {}
        # Match the CI poller's coverage (#1850): SubtensorModule + Balances, so
        # realtime ingest captures native-TAO Transfer events too (extract()
        # returns None for any non-indexed kind, so this only widens, never noise).
        if e.get("module_id") not in ("SubtensorModule", "Balances"):
            continue
        ent = extract(e.get("event_id"), e.get("attributes"))
        if ent is None:
            continue
        # Link the event to its emitting extrinsic (#1849), kept 1:1 with the CI
        # poller's fetch-events.py emit: the ApplyExtrinsic-phase extrinsic_idx,
        # null for Initialization/Finalization events.
        xidx = v.get("extrinsic_idx") if v.get("phase") == "ApplyExtrinsic" else None
        if not isinstance(xidx, int) or xidx < 0:
            xidx = None
        event_rows.append(
            {
                "block_number": block_number,
                "event_index": event_index,
                "event_kind": e.get("event_id"),
                "hotkey": ent["hotkey"],
                "coldkey": ent["coldkey"],
                "netuid": ent["netuid"],
                "uid": ent["uid"],
                "amount_tao": ent["amount_tao"],
                "alpha_amount": ent["alpha_amount"],
                "observed_at": head_ts if head_ts else None,
                "extrinsic_index": xidx,
            }
        )
    # Block-explorer block + extrinsic rows (#1345 Option B). The _fe helpers are
    # best-effort (never raise); the caller supplies observed_at (the same block
    # timestamp the events use). A None block row / empty extrinsics is fine — the
    # Worker's validators drop incomplete rows before they touch D1.
    block_row = _fe.block_extras(s, block_number, block_hash, len(events))
    if block_row is not None:
        block_row["observed_at"] = head_ts
    extrinsic_rows = _fe.extrinsics_for_block(s, block_number, block_hash, events)
    for xrow in extrinsic_rows:
        xrow["observed_at"] = head_ts
    return {"events": event_rows, "block": block_row, "extrinsics": extrinsic_rows}


def push(url, payload):
    """POST a JSON payload to an ingest endpoint. Returns True on success; logs WARN
    + returns False on a transient network failure (the CI poller backstop covers
    the gap). A TLS/certificate verification failure is NOT a transient blip — it's
    logged at ERROR and the process exits, so a possible MITM on the secret-bearing
    POST is surfaced (Railway restarts a transient one; a persistent one crash-loops
    to the retry cap + goes visibly down) rather than silently swallowed."""
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        method="POST",
        headers={
            "content-type": "application/json",
            # Real User-Agent: the default Python-urllib UA is 403'd by the
            # Cloudflare WAF in front of the Worker.
            "user-agent": "metagraphed-streamer/1.0",
            TOKEN_HEADER: SECRET,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=PUSH_TIMEOUT) as resp:
            resp.read()
        return True
    except urllib.error.HTTPError as e:
        log.warning(
            "ingest push rejected (HTTP %s) — poller backstop will cover this gap",
            e.code,
        )
        return False
    except urllib.error.URLError as e:
        # urlopen surfaces a cert verification failure as URLError(reason=SSLError).
        # Never silently swallow a TLS failure on this secret-bearing endpoint.
        if isinstance(e.reason, ssl.SSLError):
            log.error(
                "TLS verification FAILED for the ingest endpoint (%s) — possible "
                "cert/MITM issue; exiting rather than continuing unverified.",
                repr(e.reason)[:160],
            )
            sys.exit(1)
        log.warning(
            "ingest push failed (%s) — poller backstop will cover this gap",
            repr(e.reason)[:120],
        )
        return False
    except ssl.SSLError as e:  # a raw (unwrapped) TLS error — same security stance
        log.error(
            "TLS error talking to the ingest endpoint (%s) — exiting rather than "
            "continuing unverified.",
            repr(e)[:160],
        )
        sys.exit(1)
    except (TimeoutError, ConnectionError, OSError) as e:
        log.warning(
            "ingest push failed (%s) — poller backstop will cover this gap",
            repr(e)[:120],
        )
        return False


def run():
    if not INGEST_URL or not SECRET:
        log.error("EVENTS_INGEST_URL and METAGRAPH_EVENTS_INGEST_SECRET are required")
        sys.exit(1)
    log.info(
        "starting · rpc=%s · ingest=%s · summary_every=%d blocks",
        RPC,
        urlparse(INGEST_URL).netloc,
        SUMMARY_EVERY,
    )
    stats = {"blocks": 0, "events": 0, "push_fail": 0, "latest": None}
    backoff = 5
    while not _stop:
        try:
            s = SubstrateInterface(url=RPC)
            log.info("connected %s — subscribing to finalized heads", RPC)
            backoff = 5  # reset after a clean connect

            def handler(obj, _update_nr, _subscription_id):
                if _stop:
                    return True  # non-None return cancels the subscription
                bn = obj["header"]["number"]
                decoded = decode_head(s, bn)
                event_rows = decoded["events"]
                # account_events → /internal/events
                ok = push(INGEST_URL, event_rows) if event_rows else True
                # blocks + extrinsics → /internal/blocks (#1345 Option B)
                block_payload = {
                    "blocks": [decoded["block"]] if decoded["block"] else [],
                    "extrinsics": decoded["extrinsics"],
                }
                if block_payload["blocks"] or block_payload["extrinsics"]:
                    ok = push(BLOCKS_INGEST_URL, block_payload) and ok
                stats["blocks"] += 1
                stats["events"] += len(event_rows)
                stats["latest"] = bn
                if not ok:
                    stats["push_fail"] += 1
                log.debug(
                    "block %s: %d events, %d extrinsics %s",
                    bn,
                    len(event_rows),
                    len(decoded["extrinsics"]),
                    "ok" if ok else "FAIL",
                )
                if stats["blocks"] % SUMMARY_EVERY == 0:
                    log.info(
                        "healthy · %d blocks · %d events · latest=#%s · push_failures=%d",
                        stats["blocks"],
                        stats["events"],
                        stats["latest"],
                        stats["push_fail"],
                    )
                return None

            s.subscribe_block_headers(handler, finalized_only=True)
        except Exception as e:  # noqa: BLE001 — connection lost; reconnect
            if _stop:
                break
            sleep_for = backoff + random.uniform(0, backoff / 2)  # jitter
            log.error(
                "stream error (%s) — reconnecting in %.1fs",
                repr(e)[:160],
                sleep_for,
            )
            time.sleep(sleep_for)
            backoff = min(backoff * 2, MAX_BACKOFF)  # exponential
    log.info("stopped · processed %d blocks total", stats["blocks"])


if __name__ == "__main__":
    run()
