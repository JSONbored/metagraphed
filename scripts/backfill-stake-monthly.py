#!/usr/bin/env python3
"""One-time MONTHLY historical STAKE backfill (#1345 / #1302) — fills the DEFERRED
`stake_tao` field in `neuron_daily` that scripts/backfill-neuron-history.py leaves NULL.

Why a SEPARATE, slower, monthly pass: per-UID dTAO stake is RUNTIME-only (childkey /
TaoWeight math), NOT a raw SubtensorModule storage read, so the fast batched
state_queryStorageAt path the daily backfiller uses cannot produce it. The runtime
`get_metagraph_info(block=N)` DOES return correct per-UID `total_stake`, but it is
~5s PER SUBNET and the MetagraphInfo runtime struct has a hard ~8-month decode floor
(decode TypeError at ~270d+ — the struct didn't exist before then). A monthly pass over
the last ~8 months is therefore the feasible enrichment: ~8 blocks x ~129 subnets.

For each month offset we resolve the block nearest a fixed UTC time-of-day, then for
every subnet pull the FULL runtime metagraph and emit the SAME `neuron_daily` row shape
as the daily backfiller — only now `stake_tao = to_tao_exact(total_stake[uid])` is populated.
The ingest upsert is idempotent on (netuid,uid,snapshot_date), so these monthly days are
overwritten in place with complete, stake-included rows (re-runs are safe/resumable).

Units match scripts/fetch-metagraph-native.py exactly:
  stake_tao / emission_tao = Balance.rao / 1e9, alpha-denominated, computed exactly
    (not float(Balance)/.tao, which loses precision above 2**53 rao — #2921)
  consensus / incentive / dividends = runtime 0..1 floats
  validator_trust = SubtensorModule u16 (0..65535) / 65535
  trust = 0.0 (dead in dTAO)
  rank = derived (1-based by incentive desc; null for non-incentivized neurons)

Connection: OnFinality's public archive endpoint — free, no API key, no rate limit,
retains historical state. In bittensor 10.4.x the metagraph helpers live on
`api.metagraphs` (NOT api.subnets).

Run (one-time; resumable):
  NEURON_DAILY_BACKFILL_SECRET=... \
  uv run --with bittensor python scripts/backfill-stake-monthly.py --months 8
"""
import argparse
import ipaddress
import json
import os
import sys
import time
import urllib.error
import urllib.request

# OnFinality public archive — free, no key, no rate limit, retains historical state.
NETWORK = "wss://bittensor-finney.api.onfinality.io/public-ws"
BLOCK_MS = 12_000  # finney block time, empirically exactly 12.0s
DAYS_PER_MONTH = 30  # month offset m = m*30 days ago (calendar-month precision n/a here)
API_BASE = os.environ.get("METAGRAPH_API_BASE", "https://api.metagraph.sh")
# /api/v1/internal/backfill-neurons (D1-only) was deleted alongside D1's
# neuron_daily table (#4772/#4908); this writes neuron_daily/
# account_position_daily's stake_tao in Postgres instead (workers/data-api.mjs's
# handleNeuronDailyBackfill), same route as backfill-neuron-history.py.
INGEST_PATH = "/api/v1/internal/backfill-neuron-daily"
INGEST_HEADER = "x-neuron-daily-backfill-token"  # NEURON_DAILY_BACKFILL_TOKEN_HEADER
SECRET = os.environ.get("NEURON_DAILY_BACKFILL_SECRET") or os.environ.get(
    "METAGRAPH_EVENTS_INGEST_SECRET", ""
)


def to_float(value):
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def to_tao_exact(balance):
    """Convert a Balance to TAO without going through float(Balance)/.tao, which
    computes the rao->TAO division in double precision internally and silently
    loses low-order digits above 2**53 rao (~9M TAO). balance.rao is the exact
    arbitrary-precision int; splitting whole/remainder before the final float
    conversion keeps the integer TAO part exact (metagraphed#2921)."""
    if balance is None:
        return None
    try:
        rao = balance.rao
    except AttributeError:
        return to_float(balance)  # not a Balance (e.g. already a plain number) — fall back
    whole = rao // 1_000_000_000
    remainder = (rao % 1_000_000_000) / 1e9
    return whole + remainder


def u16_ratio(value):
    """SubtensorModule ValidatorTrust is u16 (0..65535) → 0..1 ratio."""
    try:
        n = int(value)
    except (TypeError, ValueError):
        return None
    return round(n / 65535, 9)


def fmt_axon(axon):
    """axons[uid] = {ip:int, port:int, ...}; ip 0 → not serving."""
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


def block_ms(sub, block_hash):
    r = sub.query("Timestamp", "Now", block_hash=block_hash)
    return int(getattr(r, "value", r) or 0)


def resolve_block(sub, target_ms, head_block, head_ms):
    """Block whose timestamp is nearest target_ms (≤1 block drift), bisecting from a
    linear estimate. Mirrors scripts/backfill-neuron-history.py."""
    est = max(1, min(int(head_block - (head_ms - target_ms) // BLOCK_MS), head_block))
    for _ in range(4):
        bh = sub.get_block_hash(est)
        drift = (block_ms(sub, bh) - target_ms) // BLOCK_MS
        if abs(drift) <= 1:
            break
        est = max(1, min(est - int(drift), head_block))
    return est


def total_networks(sub, block_hash):
    return int(
        getattr(
            sub.query("SubtensorModule", "TotalNetworks", [], block_hash=block_hash),
            "value",
            0,
        )
        or 0
    )


def validator_trust_vec(sub, netuid, block_hash):
    """ValidatorTrust isn't carried in MetagraphInfo in dTAO — read it from storage at
    the historical block (mirrors fetch-metagraph-native.py's storage_vec)."""
    try:
        r = sub.query("SubtensorModule", "ValidatorTrust", [netuid], block_hash=block_hash)
        return list(getattr(r, "value", r) or [])
    except Exception:
        return []


def build_subnet_rows(info, vtrust_vec, netuid, block, captured_at, snapshot_date):
    """One subnet's runtime MetagraphInfo → neuron_daily rows, INCLUDING stake_tao.
    Same row shape as scripts/backfill-neuron-history.py:build_rows, field extraction
    matching scripts/fetch-metagraph-native.py."""
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

    subnet_rows = []
    for uid in range(n):
        hotkey = _at(hotkeys, uid)
        if not hotkey:
            continue  # ingest rejects null-hotkey rows (mirrors forward path)
        reg = _at(reg_at, uid)
        subnet_rows.append(
            {
                "netuid": netuid,
                "uid": uid,
                "hotkey": hotkey,
                "coldkey": _at(coldkeys, uid),
                "active": 1 if _at(active, uid) else 0,
                "validator_permit": 1 if _at(permits, uid) else 0,
                "rank": None,  # derived below
                "trust": 0.0,
                "validator_trust": u16_ratio(_at(vtrust_vec, uid)),
                "consensus": to_float(_at(consensus, uid)),
                "incentive": to_float(_at(incentives, uid)),
                "dividends": to_float(_at(dividends, uid)),
                "emission_tao": to_tao_exact(_at(emission, uid)),
                "stake_tao": to_tao_exact(_at(stake, uid)),  # THE point of this pass
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
    # Derive rank: 1-based by incentive desc (null for non-incentivized neurons),
    # matching fetch-metagraph-native.py / backfill-neuron-history.py.
    for pos, row in enumerate(
        sorted(
            (r for r in subnet_rows if r["incentive"]),
            key=lambda r: (-r["incentive"], r["uid"]),
        ),
        start=1,
    ):
        row["rank"] = float(pos)
    return subnet_rows


def post_chunk(rows, dry_run):
    if dry_run or not rows:
        return
    body = json.dumps({"rows": rows}).encode()
    headers = {
        "content-type": "application/json",
        INGEST_HEADER: SECRET,
        "user-agent": "metagraphed-backfill/2.0",  # CF WAF 403s default urllib UA
    }
    # Retry transient ingest/D1 errors (5xx/429/network) with backoff.
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
    p.add_argument("--months", type=int, default=8, help="months back (decode floor ~8)")
    p.add_argument("--hour", type=int, default=5, help="UTC hour (forward cron is 47 5)")
    p.add_argument("--minute", type=int, default=47)
    p.add_argument("--chunk", type=int, default=1000, help="rows per ingest POST")
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()
    if not SECRET and not args.dry_run:
        sys.exit("METAGRAPH_BACKFILL_SECRET is required (or use --dry-run)")

    import bittensor as bt  # lazy: keeps this module loadable (e.g. for unit tests)
    # without the heavy SDK installed, matching fetch-events.py's convention.

    # bittensor 10.4.x: metagraph helpers live on api.metagraphs (NOT api.subnets).
    api = bt.SubtensorApi(network=NETWORK)
    sub = api.substrate
    head_block = int(api.block)
    head_ms = block_ms(sub, sub.get_block_hash(head_block))
    sys.stderr.write(
        f"connected {NETWORK}\nhead {head_block} @ {head_ms}ms; "
        f"backfilling stake for {args.months} month(s)\n"
    )

    day_ms = 86_400_000
    midnight = (int(time.time() * 1000) // day_ms) * day_ms
    tod = (args.hour * 3600 + args.minute * 60) * 1000
    total_rows = 0
    for m in range(1, args.months + 1):
        target_ms = midnight - m * DAYS_PER_MONTH * day_ms + tod
        snapshot_date = time.strftime("%Y-%m-%d", time.gmtime(target_ms / 1000))
        block = resolve_block(sub, target_ms, head_block, head_ms)
        bh = sub.get_block_hash(block)
        captured_at = block_ms(sub, bh)
        total = total_networks(sub, bh)
        rows = []
        fetched = 0
        errors = 0
        for netuid in range(total):
            try:
                info = api.metagraphs.get_metagraph_info(netuid=netuid, block=block)
            except Exception as e:
                errors += 1
                sys.stderr.write(
                    f"  netuid {netuid} @ block {block}: {repr(e)[:120]}\n"
                )
                continue
            if info is None:
                continue
            vtrust_vec = validator_trust_vec(sub, netuid, bh)
            subnet_rows = build_subnet_rows(
                info, vtrust_vec, netuid, block, captured_at, snapshot_date
            )
            rows.extend(subnet_rows)
            fetched += 1
        for i in range(0, len(rows), args.chunk):
            post_chunk(rows[i : i + args.chunk], args.dry_run)
        total_rows += len(rows)
        with_stake = sum(1 for r in rows if r["stake_tao"] is not None)
        sys.stderr.write(
            f"{snapshot_date} block {block} ({fetched}/{total} subnets, {errors} err)"
            f" -> {len(rows)} rows ({with_stake} with stake)"
            f"{' [dry-run]' if args.dry_run else ''}\n"
        )
        # Dry-run: print a known-active subnet's top stakes so a human can eyeball that
        # historical runtime stake is populated and plausible.
        if args.dry_run:
            sample = sorted(
                (r for r in rows if r["netuid"] == 8 and r["stake_tao"]),
                key=lambda r: -r["stake_tao"],
            )[:3]
            for r in sample:
                sys.stderr.write(
                    f"    sample netuid 8 uid {r['uid']}: "
                    f"stake_tao={r['stake_tao']} emission_tao={r['emission_tao']}\n"
                )
    sys.stderr.write(f"done: {total_rows} rows across {args.months} month(s)\n")


if __name__ == "__main__":
    main()
