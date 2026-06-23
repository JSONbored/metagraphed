#!/usr/bin/env python3
"""Historical per-UID metagraph BACKFILL (#1345 Phase 1) — chain-direct off the
public ARCHIVE node, no API key. Fills `neuron_daily` retroactively so the history
endpoints serve a real time-series NOW instead of accruing forward over months.

For each target UTC day it resolves the block nearest a fixed time-of-day (the
forward rollup's cron minute, so backfilled and live rows line up), then per subnet
calls the per-subnet runtime API `get_metagraph_info(netuid, block=N)` (the bulk
`get_all_metagraphs_info` is HEAD-only — it errors at historical blocks) plus a
`ValidatorTrust` storage read at that block hash, emitting the EXACT
`NEURON_INSERT_COLUMNS` + `snapshot_date` shape the Worker's
`/api/v1/internal/backfill-neurons` ingest expects (idempotent upsert on
(netuid,uid,snapshot_date), so re-runs are safe/resumable).

Units match scripts/fetch-metagraph-native.py (verified vs Taostats, #1348):
  stake_tao/emission_tao = float(Balance, alpha-denominated)
  consensus/incentive/dividends = on-chain 0..1 floats
  validator_trust = SubtensorModule u16 (0..65535) / 65535
  rank = derived (1-based, incentive desc); trust = 0.0 (dead in dTAO)

Why archive: events/metagraph at block N live in STATE at that block's hash, which a
pruned public node discards (~256 blocks). archive.chain.opentensor.ai retains full
historical state (verified). dTAO launched ~block 4,920,351 (2025-02-13); the past
year is entirely post-dTAO so units are consistent.

Run (one-time; resumable):
  METAGRAPH_BACKFILL_SECRET=... \
  uv run --with bittensor python scripts/backfill-neuron-history.py --days 365
"""
import argparse
import ipaddress
import json
import os
import sys
import time
import urllib.request

import bittensor as bt

BLOCK_MS = 12_000  # finney block time, empirically exactly 12.0s
API_BASE = os.environ.get("METAGRAPH_API_BASE", "https://api.metagraph.sh")
INGEST_PATH = "/api/v1/internal/backfill-neurons"
INGEST_HEADER = "x-metagraph-events-token"  # EVENTS_INGEST_TOKEN_HEADER
SECRET = os.environ.get("METAGRAPH_BACKFILL_SECRET") or os.environ.get(
    "METAGRAPH_EVENTS_INGEST_SECRET", ""
)


def to_float(value):
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def u16_ratio(value):
    try:
        n = int(value)
    except (TypeError, ValueError):
        return None
    return round(n / 65535, 9)


def fmt_axon(axon):
    if not isinstance(axon, dict):
        return None
    ip = axon.get("ip") or 0
    port = axon.get("port") or 0
    if not ip:
        return None
    try:
        host = str(ipaddress.ip_address(int(ip)))
    except (ValueError, TypeError):
        return None
    return f"{host}:{port}" if port else host


def _at(arr, i):
    return arr[i] if i < len(arr) else None


def block_ms(s, block_hash):
    """Timestamp.Now (epoch ms) at a block hash."""
    r = s.substrate.query("Timestamp", "Now", block_hash=block_hash)
    return int(getattr(r, "value", r) or 0)


def resolve_block(s, target_ms, head_block, head_ms):
    """Block whose timestamp is closest to target_ms (estimate + refine)."""
    est = head_block - (head_ms - target_ms) // BLOCK_MS
    est = max(1, min(int(est), head_block))
    for _ in range(4):
        bh = s.substrate.get_block_hash(est)
        ts = block_ms(s, bh)
        drift = (ts - target_ms) // BLOCK_MS
        if abs(drift) <= 1:
            break
        est = max(1, min(est - int(drift), head_block))
    return est


def storage_vec(s, netuid, name, block_hash):
    try:
        r = s.substrate.query("SubtensorModule", name, [netuid], block_hash=block_hash)
        return list(getattr(r, "value", r) or [])
    except Exception:
        return []


def subnet_rows(info, netuid, vtrust_vec, snapshot_date, captured_at, block):
    hotkeys = list(getattr(info, "hotkeys", []) or [])
    n = len(hotkeys)
    if not n:
        return []
    coldkeys = list(getattr(info, "coldkeys", []) or [])
    active = list(getattr(info, "active", []) or [])
    permits = list(getattr(info, "validator_permit", []) or [])
    consensus = list(getattr(info, "consensus", []) or [])
    incentives = list(getattr(info, "incentives", []) or [])
    dividends = list(getattr(info, "dividends", []) or [])
    emission = list(getattr(info, "emission", []) or [])
    stake = list(getattr(info, "total_stake", []) or [])
    axons = list(getattr(info, "axons", []) or [])
    reg_at = list(getattr(info, "block_at_registration", []) or [])
    immunity = int(getattr(info, "immunity_period", 0) or 0)
    rows = []
    for uid in range(n):
        reg = _at(reg_at, uid)
        rows.append(
            {
                "netuid": netuid,
                "uid": uid,
                "hotkey": _at(hotkeys, uid),
                "coldkey": _at(coldkeys, uid),
                "active": 1 if _at(active, uid) else 0,
                "validator_permit": 1 if _at(permits, uid) else 0,
                "rank": None,
                "trust": 0.0,
                "validator_trust": u16_ratio(_at(vtrust_vec, uid)),
                "consensus": to_float(_at(consensus, uid)),
                "incentive": to_float(_at(incentives, uid)),
                "dividends": to_float(_at(dividends, uid)),
                "emission_tao": to_float(_at(emission, uid)),
                "stake_tao": to_float(_at(stake, uid)),
                "registered_at_block": reg,
                "is_immunity_period": 1
                if (reg is not None and block - reg < immunity)
                else 0,
                "axon": fmt_axon(_at(axons, uid)),
                "block_number": block,
                "captured_at": captured_at,
                "snapshot_date": snapshot_date,
            }
        )
    # Derive Taostats-style rank: 1-based by incentive desc (null when no incentive).
    for pos, row in enumerate(
        sorted(
            (r for r in rows if r["incentive"]),
            key=lambda r: (-r["incentive"], r["uid"]),
        ),
        start=1,
    ):
        row["rank"] = float(pos)
    return [r for r in rows if r["hotkey"]]


def post_chunk(rows, dry_run):
    if dry_run or not rows:
        return len(rows)
    body = json.dumps({"rows": rows}).encode()
    req = urllib.request.Request(
        API_BASE + INGEST_PATH,
        data=body,
        method="POST",
        headers={
            "content-type": "application/json",
            INGEST_HEADER: SECRET,
            # CF WAF 403s the default Python-urllib UA (same gotcha as the streamer).
            "user-agent": "metagraphed-backfill/1.0",
        },
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        json.loads(resp.read())
    return len(rows)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--network", default="archive")
    p.add_argument("--days", type=int, default=365, help="how many days back to fill")
    p.add_argument("--end-offset", type=int, default=1, help="newest day = today-N")
    p.add_argument("--hour", type=int, default=5, help="UTC hour to sample (cron 47 5)")
    p.add_argument("--minute", type=int, default=47)
    p.add_argument("--chunk", type=int, default=1500, help="rows per ingest POST")
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()

    if not SECRET and not args.dry_run:
        sys.exit("METAGRAPH_BACKFILL_SECRET is required (or use --dry-run)")

    s = bt.SubtensorApi(network=args.network)
    head_block = int(s.block)
    head_ms = block_ms(s, s.substrate.get_block_hash(head_block))
    sys.stderr.write(f"head block {head_block} @ {head_ms}ms; archive={args.network}\n")

    day_ms = 86_400_000
    now_ms = int(time.time() * 1000)
    midnight = (now_ms // day_ms) * day_ms
    tod = (args.hour * 3600 + args.minute * 60) * 1000

    total_rows = 0
    for offset in range(args.end_offset, args.end_offset + args.days):
        target_ms = midnight - offset * day_ms + tod
        snapshot_date = time.strftime("%Y-%m-%d", time.gmtime(target_ms / 1000))
        block = resolve_block(s, target_ms, head_block, head_ms)
        bh = s.substrate.get_block_hash(block)
        captured_at = block_ms(s, bh)
        total = int(
            getattr(
                s.substrate.query("SubtensorModule", "TotalNetworks", [], block_hash=bh),
                "value",
                0,
            )
            or 0
        )
        pending, day_rows = [], 0
        for netuid in range(total):
            try:
                info = s.metagraphs.get_metagraph_info(netuid=netuid, block=block)
            except Exception:
                continue
            vtrust = storage_vec(s, netuid, "ValidatorTrust", bh)
            rows = subnet_rows(info, netuid, vtrust, snapshot_date, captured_at, block)
            pending.extend(rows)
            day_rows += len(rows)
            while len(pending) >= args.chunk:
                post_chunk(pending[: args.chunk], args.dry_run)
                pending = pending[args.chunk :]
        if pending:
            post_chunk(pending, args.dry_run)
        total_rows += day_rows
        sys.stderr.write(
            f"{snapshot_date} block {block} ({total} subnets) -> {day_rows} rows"
            f"{' [dry-run]' if args.dry_run else ''}\n"
        )

    sys.stderr.write(f"done: {total_rows} rows across {args.days} days\n")


if __name__ == "__main__":
    main()
