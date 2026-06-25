#!/usr/bin/env python3
"""Historical block-explorer backfill (#1749, ADR 0012) — fills the `blocks` /
`extrinsics` / `account_events` D1 tiers for a PAST block range from a WS ARCHIVE.

The live streamer (#1754) + the CI poller only cover RECENT blocks; older gaps (the
~58% the coalesced poller left before the streamer fix) are pruned from public RPC
and can only be recovered from an archive that retains historical state + block
bodies. This scans an explicit `[--from, --to]` range and writes the SAME staged
JSON files (account-events / blocks / extrinsics) the refresh-events sign + stage
steps load into D1 via the Worker's loadStaged* — INSERT OR IGNORE on the PKs, so
re-running or overlapping a range is free (idempotent).

Reuses the EXACT verified decode from fetch-events.py (block_extras,
extrinsics_for_block, extract) — no drift. observed_at is anchored on the current
finalized head's timestamp (finney is exactly 12.0s/block), the same height-derived
clock the live poller uses, so no per-block Timestamp query is needed.

The public finney RPC prunes ~300 blocks, so point this at an ARCHIVE. The Subway
proxy `archive.chain.opentensor.ai` serves raw state over HTTP-JSON-RPC but does NOT
speak substrate-interface's WS protocol — use a real WS archive. OnFinality's free
public WSS is the default and is already used by the stake/neuron backfills.

Run:  SUBTENSOR_RPC_URL=wss://bittensor-finney.api.onfinality.io/public-ws \
      uv run --with substrate-interface==1.8.1 \
      python scripts/backfill-events.py --from 8474393 --to 8475893
Env:  SUBTENSOR_RPC_URL   WS archive endpoint (default below)
Output paths reuse fetch-events.py's ACCOUNT_EVENTS_JSON / BLOCKS_JSON / EXTRINSICS_JSON.
"""
import argparse
import importlib.util
import json
import os
import sys
import time
from urllib.parse import urlsplit, urlunsplit

# Reuse fetch-events.py's verified decode (hyphenated → load by path, same as the
# streamer + the unit tests do).
_FE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fetch-events.py")
_spec = importlib.util.spec_from_file_location("fetch_events_backfill", _FE_PATH)
_fe = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_fe)

# A real WS archive (full historical state + block bodies). NOT the Subway HTTP
# proxy — that doesn't speak substrate-interface's WS protocol (#1749).
DEFAULT_ARCHIVE = "wss://bittensor-finney.api.onfinality.io/public-ws"
FINNEY_GENESIS_HASH = (
    "0x2f0555cc76fc2840a25a6ea3b9637146806f1f44b090c175ffde2a7e5ab36c03"
)
TRUSTED_ARCHIVE_URLS = frozenset([DEFAULT_ARCHIVE])


def _normalize_url(url):
    parts = urlsplit((url or "").strip())
    if parts.scheme not in {"ws", "wss"} or not parts.netloc:
        raise ValueError("SUBTENSOR_RPC_URL must be a ws:// or wss:// archive URL")
    host = (parts.hostname or "").lower()
    netloc = host
    if parts.port is not None:
        netloc = f"{host}:{parts.port}"
    return urlunsplit((parts.scheme.lower(), netloc, parts.path.rstrip("/"), "", ""))


def _trusted_archive_urls():
    extra = os.environ.get("BACKFILL_TRUSTED_ARCHIVE_URLS", "")
    urls = list(TRUSTED_ARCHIVE_URLS) + [u for u in extra.split(",") if u.strip()]
    return frozenset(_normalize_url(u) for u in urls)


def _select_archive_url():
    selected = _normalize_url(os.environ.get("SUBTENSOR_RPC_URL") or DEFAULT_ARCHIVE)
    trusted = _trusted_archive_urls()
    if selected not in trusted:
        allowed = ", ".join(sorted(trusted))
        raise ValueError(
            "SUBTENSOR_RPC_URL is not trusted for production backfill; "
            f"allowed: {allowed}"
        )
    return selected


def _verify_finney_chain(substrate):
    genesis = substrate.get_block_hash(0)
    if str(genesis).strip().lower() != FINNEY_GENESIS_HASH:
        raise ValueError("archive endpoint is not finney mainnet: genesis hash mismatch")


def _header_number(substrate, block_hash):
    header = substrate.get_block_header(block_hash=block_hash)["header"]
    return int(header["number"])


def main():
    from substrateinterface import SubstrateInterface

    p = argparse.ArgumentParser()
    p.add_argument("--from", dest="from_block", type=int, required=True)
    p.add_argument("--to", dest="to_block", type=int, required=True)
    args = p.parse_args()
    if args.from_block < 0 or args.to_block < args.from_block:
        sys.exit("--from must be >= 0 and <= --to")

    try:
        url = _select_archive_url()
    except ValueError as e:
        sys.exit(str(e))
    s = SubstrateInterface(url=url)
    # Free archives (OnFinality) rate-limit (JSON-RPC -32029 "Too Many Requests")
    # under rapid block-by-block scanning. Wrap the RPC layer so EVERY call backs off
    # and retries on a rate limit instead of skipping the block — the scan then
    # self-paces to the endpoint's sustainable rate. All per-block calls
    # (get_block_hash, System.Events query, get_block(_header), Aura query) route
    # through rpc_request, so one wrap covers them. A non-rate-limit error still
    # raises (→ the per-block skip / best-effort None). No-op if the attr is absent.
    _orig_rpc = getattr(s, "rpc_request", None)
    if _orig_rpc is not None:

        def _rpc_request(method, params, *a, **k):
            delay = 1.0
            for _ in range(8):
                try:
                    return _orig_rpc(method, params, *a, **k)
                except Exception as e:  # noqa: BLE001 — inspect, retry only on 429
                    msg = repr(e)
                    if "-32029" in msg or "Too Many Requests" in msg:
                        time.sleep(delay)
                        delay = min(delay * 2, 30)
                        continue
                    raise
            return _orig_rpc(method, params, *a, **k)

        s.rpc_request = _rpc_request
    try:
        _verify_finney_chain(s)
    except ValueError as e:
        sys.exit(str(e))

    # Anchor observed_at on the current finalized head's timestamp; finney is exactly
    # 12.0s/block, so height-derivation matches the live poller's clock with no
    # per-block Timestamp query (one fewer archive round-trip per block).
    head = s.get_chain_finalised_head()
    head_bn = _header_number(s, head)
    head_ts = int(s.query("Timestamp", "Now", block_hash=head).value)

    rows, blocks, extrinsics = [], [], []
    scanned = skipped = 0
    for bn in range(args.from_block, args.to_block + 1):
        observed_at = head_ts - (head_bn - bn) * _fe.BLOCK_MS
        try:
            bh = s.get_block_hash(bn)
            if _header_number(s, bh) != bn:
                raise ValueError("block header number mismatch")
            events = s.query("System", "Events", block_hash=bh)
        except Exception as e:  # transient/shape drift → skip this block, keep going
            skipped += 1
            sys.stderr.write(f"block {bn}: skip ({repr(e)[:80]})\n")
            continue
        scanned += 1
        extras = _fe.block_extras(s, bn, bh, len(events))
        if extras is not None:
            extras["observed_at"] = observed_at
            blocks.append(extras)
        for xrow in _fe.extrinsics_for_block(s, bn, bh, events):
            xrow["observed_at"] = observed_at
            extrinsics.append(xrow)
        # account_events rows — mirrors fetch-events.py main()'s row shape (the
        # decode helper `extract` is reused; only this assembly is repeated).
        for event_index, ev in enumerate(events):
            v = ev.value if isinstance(ev.value, dict) else {}
            e = v.get("event", {}) if isinstance(v.get("event"), dict) else {}
            if e.get("module_id") != "SubtensorModule":
                continue
            ent = _fe.extract(e.get("event_id"), e.get("attributes"))
            if ent is None:
                continue
            rows.append(
                {
                    "block_number": bn,
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

    for path, data in (
        (_fe.OUT, rows),
        (_fe.BLOCKS_OUT, blocks),
        (_fe.EXTRINSICS_OUT, extrinsics),
    ):
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "w") as fh:
            json.dump(data, fh)

    sys.stderr.write(
        f"backfill {args.from_block}..{args.to_block} via {url}: "
        f"scanned {scanned}, skipped {skipped} -> {len(rows)} events, "
        f"{len(blocks)} blocks, {len(extrinsics)} extrinsics\n"
    )


if __name__ == "__main__":
    main()
