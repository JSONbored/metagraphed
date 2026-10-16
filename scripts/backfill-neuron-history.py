#!/usr/bin/env python3
"""Legacy approximate per-UID metric projection (#1345 Phase 1).

Metric vectors are read at a sampled historical block, but identity, registration
and axon fields come from a CURRENT-head overlay. The legacy subnet census also
assumes dense netuids from TotalNetworks. Reused UIDs, removed/sparse subnets and
runtime/pruning boundaries prevent this from proving authentic historical state.
Historical storage and compatible runtime metadata must actually be available;
block/extrinsic retention alone cannot regenerate missing state.

Use --dry-run for inspection. Writes additionally require the explicit
--allow-approximate-history acknowledgement. This path does not produce the
same-finalized-hash identity/census/runtime originals required for qualified
historical recovery. Exact rao conversion does not qualify identity or coverage.

Example (inspection only):
  uv run --project scripts python scripts/backfill-neuron-history.py --dry-run --days 1
"""
import argparse
import ipaddress
import json
import os
import sys
import time
import urllib.error
import urllib.request

import bittensor as bt
import xxhash

BLOCK_MS = 12_000  # finney block time, empirically exactly 12.0s
METRIC_VECTORS = (
    "Active",
    "ValidatorPermit",
    "Consensus",
    "Incentive",
    "Dividends",
    "Emission",
    "ValidatorTrust",
)
KEY_CHUNK = 50  # >100 keys/call hits a latency cliff; 50 is the measured sweet spot
API_BASE = os.environ.get("METAGRAPH_API_BASE", "https://api.metagraph.sh")
# /api/v1/internal/backfill-neurons (D1-only) was deleted alongside D1's
# neuron_daily table (#4772/#4908); this writes neuron_daily/
# account_position_daily in Postgres instead (workers/data-api.ts's
# handleNeuronDailyBackfill) via its own dedicated secret/header -- NOT
# neurons-sync's (that route also touches the latest-only `neurons` table and
# runs a deregistration prune, both wrong for a historical backfill).
INGEST_PATH = "/api/v1/internal/backfill-neuron-daily"
INGEST_HEADER = "x-neuron-daily-backfill-token"  # NEURON_DAILY_BACKFILL_TOKEN_HEADER
SECRET = os.environ.get("NEURON_DAILY_BACKFILL_SECRET") or os.environ.get(
    "METAGRAPH_EVENTS_INGEST_SECRET", ""
)

_PALLET = None


def twox128(data: bytes) -> bytes:
    return xxhash.xxh64(data, seed=0).intdigest().to_bytes(8, "little") + xxhash.xxh64(
        data, seed=1
    ).intdigest().to_bytes(8, "little")


def storage_key(item: str, netuid: int) -> str:
    """SubtensorModule.<item>[netuid] — Identity-hashed per-netuid map. Built OFFLINE
    (substrate.create_storage_key does a network round-trip per key)."""
    global _PALLET
    if _PALLET is None:
        _PALLET = twox128(b"SubtensorModule")
    return "0x" + (_PALLET + twox128(item.encode()) + int(netuid).to_bytes(2, "little")).hex()


def read_compact(b, i):
    """SCALE compact-length prefix -> (value, next_index)."""
    b0 = b[i]
    mode = b0 & 0b11
    if mode == 0:
        return b0 >> 2, i + 1
    if mode == 1:
        return int.from_bytes(b[i : i + 2], "little") >> 2, i + 2
    if mode == 2:
        return int.from_bytes(b[i : i + 4], "little") >> 2, i + 4
    n = (b0 >> 2) + 4
    return int.from_bytes(b[i + 1 : i + 1 + n], "little"), i + 1 + n


def _bytes(hexval):
    return bytes.fromhex(hexval[2:] if hexval.startswith("0x") else hexval)


def decode_vec_uint(hexval, size):
    if not hexval:
        return []
    b = _bytes(hexval)
    n, i = read_compact(b, 0)
    return [int.from_bytes(b[i + k * size : i + (k + 1) * size], "little") for k in range(n)]


def decode_vec_bool(hexval):
    if not hexval:
        return []
    b = _bytes(hexval)
    n, i = read_compact(b, 0)
    return [b[i + k] != 0 for k in range(n)]


def u16_ratio(v):
    return round(int(v) / 65535, 9) if v is not None else None


def rao_to_tao_exact(rao):
    """Whole/remainder split so the integer TAO part is always exact — plain
    `rao / 1e9` routes the whole rao integer through double rounding before
    the division even happens, silently corrupting values above 2**53 rao
    (~9M TAO) (metagraphed#2921). `rao` here is already an exact
    arbitrary-precision int from decode_vec_uint, so this loses nothing that
    wasn't already lost by the old `round(emission[uid] / 1e9, 9)`."""
    if rao is None:
        return None
    whole = rao // 1_000_000_000
    remainder = (rao % 1_000_000_000) / 1e9
    return whole + remainder


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


def block_ms(sub, block_hash):
    r = sub.query("Timestamp", "Now", block_hash=block_hash)
    return int(getattr(r, "value", r) or 0)


def resolve_block(sub, target_ms, head_block, head_ms):
    est = max(1, min(int(head_block - (head_ms - target_ms) // BLOCK_MS), head_block))
    for _ in range(4):
        bh = sub.get_block_hash(est)
        drift = (block_ms(sub, bh) - target_ms) // BLOCK_MS
        if abs(drift) <= 1:
            break
        est = max(1, min(est - int(drift), head_block))
    return est


def build_overlay(api):
    """One-shot current snapshot -> {netuid: {uid: {hotkey, coldkey, reg, immunity, axon}}}."""
    overlay = {}
    infos = api.metagraphs.get_all_metagraphs_info(all_mechanisms=True)
    for info in infos:
        nu = int(info.netuid)
        mechid = int(getattr(info, "mechid", 0) or 0)
        if nu in overlay and mechid != 0:
            continue
        hotkeys = list(getattr(info, "hotkeys", []) or [])
        coldkeys = list(getattr(info, "coldkeys", []) or [])
        axons = list(getattr(info, "axons", []) or [])
        reg_at = list(getattr(info, "block_at_registration", []) or [])
        immunity = int(getattr(info, "immunity_period", 0) or 0)
        uids = {}
        for uid in range(len(hotkeys)):
            uids[uid] = {
                "hotkey": hotkeys[uid] if uid < len(hotkeys) else None,
                "coldkey": coldkeys[uid] if uid < len(coldkeys) else None,
                "reg": reg_at[uid] if uid < len(reg_at) else None,
                "immunity": immunity,
                "axon": fmt_axon(axons[uid]) if uid < len(axons) else None,
            }
        overlay[nu] = uids
    return overlay


def fetch_block_metrics(sub, netuids, block_hash):
    """Batched state_queryStorageAt over every (netuid, metric) key -> raw hex per pair."""
    keymap, keys = {}, []
    for n in netuids:
        for item in METRIC_VECTORS:
            k = storage_key(item, n)
            keys.append(k)
            keymap[k.lower()] = (n, item)
    raw = {}
    for i in range(0, len(keys), KEY_CHUNK):
        chunk = keys[i : i + KEY_CHUNK]
        for attempt in range(4):
            try:
                res = sub.rpc_request("state_queryStorageAt", [chunk, block_hash])
                for k, v in res["result"][0]["changes"]:
                    if v is not None:
                        raw[keymap[k.lower()]] = v
                break
            except Exception as e:
                if attempt == 3:
                    raise
                sys.stderr.write(f"chunk retry {attempt + 1}: {repr(e)[:80]}\n")
                time.sleep(2 * (attempt + 1))
    return raw


def build_rows(raw, overlay, netuids, block, captured_at, snapshot_date):
    rows, skipped = [], 0
    for netuid in netuids:
        emission = decode_vec_uint(raw.get((netuid, "Emission")), 8)
        n = len(emission)
        if not n:
            continue
        consensus = decode_vec_uint(raw.get((netuid, "Consensus")), 2)
        incentive = decode_vec_uint(raw.get((netuid, "Incentive")), 2)
        dividends = decode_vec_uint(raw.get((netuid, "Dividends")), 2)
        vtrust = decode_vec_uint(raw.get((netuid, "ValidatorTrust")), 2)
        active = decode_vec_bool(raw.get((netuid, "Active")))
        vpermit = decode_vec_bool(raw.get((netuid, "ValidatorPermit")))
        ov = overlay.get(netuid, {})
        subnet_rows = []
        for uid in range(n):
            ident = ov.get(uid)
            if not ident or not ident.get("hotkey"):
                skipped += 1
                continue  # no identity overlay -> ingest would reject (needs hotkey)
            reg = ident.get("reg")
            immunity = ident.get("immunity") or 0
            subnet_rows.append(
                {
                    "netuid": netuid,
                    "uid": uid,
                    "hotkey": ident["hotkey"],
                    "coldkey": ident.get("coldkey"),
                    "active": 1 if (uid < len(active) and active[uid]) else 0,
                    "validator_permit": 1
                    if (uid < len(vpermit) and vpermit[uid])
                    else 0,
                    "rank": None,
                    "trust": 0.0,
                    "validator_trust": u16_ratio(vtrust[uid])
                    if uid < len(vtrust)
                    else None,
                    "consensus": u16_ratio(consensus[uid])
                    if uid < len(consensus)
                    else None,
                    "incentive": u16_ratio(incentive[uid])
                    if uid < len(incentive)
                    else None,
                    "dividends": u16_ratio(dividends[uid])
                    if uid < len(dividends)
                    else None,
                    "emission_tao": rao_to_tao_exact(emission[uid]),
                    "stake_tao": None,  # deferred: runtime-only in dTAO
                    "registered_at_block": reg,
                    "is_immunity_period": 1
                    if (reg is not None and block - reg < immunity)
                    else 0,
                    "axon": ident.get("axon"),
                    "block_number": block,
                    "captured_at": captured_at,
                    "snapshot_date": snapshot_date,
                }
            )
        # Derive rank: 1-based by incentive desc (null when no incentive).
        for pos, row in enumerate(
            sorted(
                (r for r in subnet_rows if r["incentive"]),
                key=lambda r: (-r["incentive"], r["uid"]),
            ),
            start=1,
        ):
            row["rank"] = float(pos)
        rows.extend(subnet_rows)
    return rows, skipped


def post_chunk(rows, dry_run):
    if dry_run or not rows:
        return
    body = json.dumps({"rows": rows}).encode()
    headers = {
        "content-type": "application/json",
        INGEST_HEADER: SECRET,
        "user-agent": "metagraphed-backfill/2.0",  # CF WAF 403s default urllib UA
    }
    # Retry transient ingest/D1 errors (5xx/429/network) with backoff — the parallel
    # shards contend on D1 and occasionally trip a 500, which must not kill the shard.
    for attempt in range(5):
        try:
            req = urllib.request.Request(
                API_BASE + INGEST_PATH, data=body, method="POST", headers=headers
            )
            with urllib.request.urlopen(req, timeout=90) as resp:
                json.loads(resp.read())
            return
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and attempt < 4:
                time.sleep(2 * (attempt + 1))
                continue
            raise
        except (urllib.error.URLError, TimeoutError):
            if attempt < 4:
                time.sleep(2 * (attempt + 1))
                continue
            raise


def main():
    p = argparse.ArgumentParser()
    # SUBTENSOR_RPC_URL override (ADR 0012 convention, same as the live-state
    # fetch scripts): unset -> the SDK's "archive" alias (a third-party public
    # archive RPC), set -> our own archive node once it finishes its genesis
    # sync (#2111).
    p.add_argument("--network", default=os.environ.get("SUBTENSOR_RPC_URL") or "archive")
    p.add_argument("--days", type=int, default=365)
    p.add_argument("--end-offset", type=int, default=1, help="newest day = today-N")
    p.add_argument("--hour", type=int, default=5, help="UTC hour (forward cron is 47 5)")
    p.add_argument("--minute", type=int, default=47)
    p.add_argument("--chunk", type=int, default=1000, help="rows per ingest POST")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--allow-approximate-history", action="store_true",
                   help="acknowledge current-head identities and dense-netuid approximation before writes")
    args = p.parse_args()
    if not args.dry_run and not args.allow_approximate_history:
        p.error("legacy head-identity/dense-netuid projection is approximate; use --dry-run or explicitly --allow-approximate-history")
    sys.stderr.write("APPROXIMATE history: head identities and dense netuids; not a qualified historical capture.\n")
    if not SECRET and not args.dry_run:
        sys.exit("METAGRAPH_BACKFILL_SECRET is required (or use --dry-run)")

    api = bt.SubtensorApi(network=args.network)
    sub = api.substrate
    head_block = int(api.block)
    head_ms = block_ms(sub, sub.get_block_hash(head_block))
    sys.stderr.write(f"head {head_block} @ {head_ms}ms; building identity overlay...\n")
    overlay = build_overlay(api)
    sys.stderr.write(f"overlay: {len(overlay)} subnets\n")

    day_ms = 86_400_000
    midnight = (int(time.time() * 1000) // day_ms) * day_ms
    tod = (args.hour * 3600 + args.minute * 60) * 1000
    total_rows = 0
    for offset in range(args.end_offset, args.end_offset + args.days):
        target_ms = midnight - offset * day_ms + tod
        snapshot_date = time.strftime("%Y-%m-%d", time.gmtime(target_ms / 1000))
        block = resolve_block(sub, target_ms, head_block, head_ms)
        bh = sub.get_block_hash(block)
        captured_at = block_ms(sub, bh)
        total = int(
            getattr(
                sub.query("SubtensorModule", "TotalNetworks", [], block_hash=bh),
                "value",
                0,
            )
            or 0
        )
        netuids = list(range(total))
        raw = fetch_block_metrics(sub, netuids, bh)
        rows, skipped = build_rows(
            raw, overlay, netuids, block, captured_at, snapshot_date
        )
        for i in range(0, len(rows), args.chunk):
            post_chunk(rows[i : i + args.chunk], args.dry_run)
        total_rows += len(rows)
        sys.stderr.write(
            f"{snapshot_date} block {block} ({total} subnets) -> {len(rows)} rows"
            f" (skipped {skipped}){' [dry-run]' if args.dry_run else ''}\n"
        )
    sys.stderr.write(f"done: {total_rows} rows across {args.days} days\n")


if __name__ == "__main__":
    main()
