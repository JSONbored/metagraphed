#!/usr/bin/env python3
"""Historical per-SUBNET alpha-price BACKFILL (#1307, epic #1302) — chain-direct off
the FREE public archive, BATCHED. Fills `subnet_snapshots.alpha_price_tao`
retroactively so the homepage marquee can show real per-subnet alpha-price
sparklines NOW instead of accruing forward over months.

This is the per-SUBNET economics analogue of scripts/backfill-neuron-history.py:
identical chain-direct machinery (offline storage keys, batched
state_queryStorageAt on the archive, block resolution, retrying ingest), but one
scalar per subnet instead of seven per-UID metric vectors.

Why raw storage (not the runtime API): get_metagraph_info(block=N) is ~18-25s PER
SUBNET with a hard ~8-month MetagraphInfo decode floor. SubnetMovingPrice lives in
plain SubtensorModule storage with NO floor, and one batched state_queryStorageAt
returns every subnet's price (~129 values) in ~one round-trip — full-year
reachable, $0, no API key.

VERIFIED FORMULA: alpha_price_tao = SubnetMovingPrice[netuid] / 2**32.
SubnetMovingPrice is declared `StorageMap<_, Identity, u16, I96F32, ValueQuery>` —
an Identity-hashed per-netuid map (same key shape as the neuron script's metric
maps) holding a 32-fractional-bit fixed-point. The raw SCALE storage value is the
fixed-point's underlying integer; decode the raw bytes as an unsigned little-endian
int (whatever length storage returns — I96F32 is 16 bytes; the magnitude fits the
low word) and divide by 2**32. Cross-checked against the runtime: for netuid 8 this
equals get_metagraph_info(netuid=8).moving_price EXACTLY, which is what the live
pipeline stores as alpha_price_tao (scripts/fetch-native-subnets.py uses
info.moving_price → to_tao → float). So the backfill matches the forward path.

Per target UTC day: resolve the block nearest a fixed time-of-day, read
TotalNetworks at that block, batch-read SubnetMovingPrice[netuid] for every netuid
as offline-built storage keys (chunked 50/call), decode each → alpha_price_tao, and
emit the exact subnet_snapshots row shape ({netuid, snapshot_date, captured_at,
alpha_price_tao}) to the secret-gated ingest (idempotent COALESCE upsert on
(netuid,snapshot_date), so re-runs are safe/resumable and never clobber a forward
fire's value or any other column).

Run (one-time; resumable):
  METAGRAPH_BACKFILL_SECRET=... \
  uvx --from bittensor==10.4.0 --with xxhash python \
    scripts/backfill-economics-history.py --days 365
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

import bittensor as bt
import xxhash

BLOCK_MS = 12_000  # finney block time, empirically exactly 12.0s
PRICE_ITEM = "SubnetMovingPrice"  # SubtensorModule storage map: Identity[u16] -> I96F32
FIXED_POINT_DIVISOR = 2**32  # 32 fractional bits (I96F32)
KEY_CHUNK = 50  # >100 keys/call hits a latency cliff; 50 is the measured sweet spot
API_BASE = os.environ.get("METAGRAPH_API_BASE", "https://api.metagraph.sh")
INGEST_PATH = "/api/v1/internal/backfill-economics"
INGEST_HEADER = "x-metagraph-events-token"  # EVENTS_INGEST_TOKEN_HEADER
SECRET = os.environ.get("METAGRAPH_BACKFILL_SECRET") or os.environ.get(
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


def _bytes(hexval):
    return bytes.fromhex(hexval[2:] if hexval.startswith("0x") else hexval)


def decode_price(hexval):
    """Raw SubnetMovingPrice storage value -> alpha_price_tao (float).

    The stored value is an I96F32 fixed-point: an unsigned little-endian integer
    whose value is `raw / 2**32`. Decode the full returned byte length (16 bytes
    for I96F32; the magnitude fits the low word, so the high bytes are zero in
    practice) so the formula is correct regardless of storage width."""
    if not hexval:
        return None
    raw = int.from_bytes(_bytes(hexval), "little")
    return round(raw / FIXED_POINT_DIVISOR, 12)


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


def fetch_block_prices(sub, netuids, block_hash):
    """Batched state_queryStorageAt over every SubnetMovingPrice[netuid] key ->
    raw hex per netuid."""
    keymap, keys = {}, []
    for n in netuids:
        k = storage_key(PRICE_ITEM, n)
        keys.append(k)
        keymap[k.lower()] = n
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


def build_rows(raw, netuids, captured_at, snapshot_date):
    rows, skipped = [], 0
    for netuid in netuids:
        price = decode_price(raw.get(netuid))
        if price is None:
            skipped += 1
            continue  # no value at this block (subnet not yet registered) -> skip
        rows.append(
            {
                "netuid": netuid,
                "snapshot_date": snapshot_date,
                "captured_at": captured_at,
                "alpha_price_tao": price,
            }
        )
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


def cross_check(api, netuid, block, batched_price):
    """Dry-run correctness probe: compare the batched-decoded alpha_price for one
    netuid against the runtime get_metagraph_info(netuid, block).moving_price at the
    same block. Best-effort — a runtime decode failure (older than the ~8-month
    MetagraphInfo floor, or an absent subnet) just prints n/a."""
    try:
        info = api.metagraphs.get_metagraph_info(netuid=netuid, block=block)
        runtime = float(getattr(info, "moving_price", None))
    except Exception as e:  # noqa: BLE001 — diagnostic only
        sys.stderr.write(f"  cross-check netuid {netuid}: runtime n/a ({repr(e)[:60]})\n")
        return
    delta = abs(runtime - batched_price) if batched_price is not None else None
    sys.stderr.write(
        f"  cross-check netuid {netuid} @ block {block}: "
        f"batched={batched_price} runtime={runtime:.12f} "
        f"delta={delta:.3e} {'OK' if (delta is not None and delta <= 1e-6) else 'MISMATCH'}\n"
    )


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--network", default="archive")
    p.add_argument("--days", type=int, default=365)
    p.add_argument("--end-offset", type=int, default=1, help="newest day = today-N")
    p.add_argument("--hour", type=int, default=5, help="UTC hour (forward cron is 47 5)")
    p.add_argument("--minute", type=int, default=47)
    p.add_argument("--chunk", type=int, default=1000, help="rows per ingest POST")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument(
        "--cross-check-netuid",
        type=int,
        default=8,
        help="dry-run: cross-check this netuid's batched price vs the runtime",
    )
    args = p.parse_args()
    if not SECRET and not args.dry_run:
        sys.exit("METAGRAPH_BACKFILL_SECRET is required (or use --dry-run)")

    api = bt.SubtensorApi(network=args.network)
    sub = api.substrate
    head_block = int(api.block)
    head_ms = block_ms(sub, sub.get_block_hash(head_block))
    sys.stderr.write(f"head {head_block} @ {head_ms}ms\n")

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
        raw = fetch_block_prices(sub, netuids, bh)
        rows, skipped = build_rows(raw, netuids, captured_at, snapshot_date)
        for i in range(0, len(rows), args.chunk):
            post_chunk(rows[i : i + args.chunk], args.dry_run)
        total_rows += len(rows)
        sys.stderr.write(
            f"{snapshot_date} block {block} ({total} subnets) -> {len(rows)} rows"
            f" (skipped {skipped}){' [dry-run]' if args.dry_run else ''}\n"
        )
        if args.dry_run and args.cross_check_netuid is not None:
            cc = args.cross_check_netuid
            decoded = next(
                (r["alpha_price_tao"] for r in rows if r["netuid"] == cc), None
            )
            cross_check(api, cc, block, decoded)
    sys.stderr.write(f"done: {total_rows} rows across {args.days} days\n")


if __name__ == "__main__":
    main()
