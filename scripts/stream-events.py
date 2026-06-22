#!/usr/bin/env python3
"""Realtime chain-event streamer (#1361, epic #1345) — Option B.

Subscribes to FINALIZED finney heads and, for each new block, decodes its
SubtensorModule events with the EXACT verified extractors from fetch-events.py
(imported, not duplicated — no drift) and POSTs them to the Worker's authenticated
ingest endpoint (#1360). End-to-end latency ~12-30s (one block). The #1346 CI
poller stays running as a self-healing backstop; inserts are idempotent on
(block_number, event_index), so any overlap is free.

This is the always-on component — run it on a cheap host (Oracle Cloud Free /
Fly.io free tier, or a ~$5/mo VPS). See docs/realtime-streamer.md + the Dockerfile.

Run:
  EVENTS_INGEST_URL=https://api.metagraph.sh/api/v1/internal/events \
  METAGRAPH_EVENTS_INGEST_SECRET=... \
  uv run --with substrate-interface==1.8.1 python scripts/stream-events.py
"""
import importlib.util
import json
import os
import sys
import time
import urllib.request

from substrateinterface import SubstrateInterface

BLOCK_MS = 12000
RPC = os.environ.get("EVENTS_RPC_URL", "wss://entrypoint-finney.opentensor.ai:443")
INGEST_URL = os.environ.get("EVENTS_INGEST_URL")
SECRET = os.environ.get("METAGRAPH_EVENTS_INGEST_SECRET")
TOKEN_HEADER = "x-metagraph-events-token"

# Reuse the EXACT verified decode from fetch-events.py (hyphenated → load by path).
_FE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fetch-events.py")
_spec = importlib.util.spec_from_file_location("fetch_events", _FE_PATH)
_fe = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_fe)
extract = _fe.extract


def decode_head(s, block_number, head_ts):
    """Decode the SubtensorModule events of one finalized block → ingest rows."""
    block_hash = s.get_block_hash(block_number)
    observed_at = head_ts if head_ts else None
    rows = []
    for event_index, ev in enumerate(
        s.query("System", "Events", block_hash=block_hash)
    ):
        v = ev.value if isinstance(ev.value, dict) else {}
        e = v.get("event", {}) if isinstance(v.get("event"), dict) else {}
        if e.get("module_id") != "SubtensorModule":
            continue
        ent = extract(e.get("event_id"), e.get("attributes"))
        if ent is None:
            continue
        rows.append(
            {
                "block_number": block_number,
                "event_index": event_index,
                "event_kind": e.get("event_id"),
                "hotkey": ent["hotkey"],
                "coldkey": ent["coldkey"],
                "netuid": ent["netuid"],
                "uid": ent["uid"],
                "amount_tao": ent["amount_tao"],
                "observed_at": observed_at,
            }
        )
    return rows


def push(rows):
    if not rows:
        return
    body = json.dumps(rows).encode()
    req = urllib.request.Request(
        INGEST_URL,
        data=body,
        method="POST",
        headers={"content-type": "application/json", TOKEN_HEADER: SECRET},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        resp.read()


def run():
    if not INGEST_URL or not SECRET:
        sys.exit("EVENTS_INGEST_URL and METAGRAPH_EVENTS_INGEST_SECRET are required")
    while True:  # reconnect loop — survives RPC drops
        try:
            s = SubstrateInterface(url=RPC)
            sys.stderr.write(f"connected {RPC}; subscribing to finalized heads\n")

            def handler(obj, update_nr, subscription_id):
                bn = obj["header"]["number"]
                try:
                    head_ts = int(s.query("Timestamp", "Now").value)
                except Exception:
                    head_ts = None
                rows = decode_head(s, bn, head_ts)
                push(rows)
                sys.stderr.write(f"block {bn}: {len(rows)} events pushed\n")

            s.subscribe_block_headers(handler, finalized_only=True)
        except Exception as e:  # noqa: BLE001 — log + reconnect
            sys.stderr.write(f"stream error: {repr(e)[:160]}; reconnecting in 5s\n")
            time.sleep(5)


if __name__ == "__main__":
    run()
