#!/usr/bin/env python3
"""Chain-wide account balance snapshot (#6742) -- the balance-based
top-holder leaderboard epic's (#6741) foundational data tier.

Reads System::Account directly via a raw storage-map scan
(query_map("System", "Account")) rather than reconstructing free/reserved
balance from transfer/stake/fee events: a direct state read is ground-truth
by construction (whatever the chain has stored right now), whereas
event-replay requires catching every possible mutation path (transaction
fees, existential-deposit reaping, staking rewards, slashing) with zero
misses -- one missed event type silently drifts the number. This codebase's
own stated bar for this data ("a true hub of accuracy") is best served by
the read that can't drift, not the reconstruction that could.

Covers EVERY account that has ever held a balance on-chain, not just
registered neurons or addresses already seen in account_events -- System is
the ground truth for existence itself; deriving scope from our own
already-indexed activity would silently miss any address that only ever
received a balance and never did anything we happen to index.

Scale (measured live against our own fullnode, 2026-07-19): 542,618 total
System::Account entries, key enumeration alone in ~91s. Comparable in row
count to fetch-validator-nominator-counts.py's own 762,577-row Alpha scan
(249s at ~3,100 rows/sec) -- same query_map(page_size=...) mechanism, same
cost tier, no per-row runtime-API call (unlike fetch-self-stake.py's
much more expensive get_stake() path).

AccountInfo's `data` field is `{ free, reserved, frozen, flags }` (u128 each,
raw planck/rao units, NOT wrapped in a bittensor SDK Balance object the way
stake amounts are -- System::Account is a plain frame-system type, not a
bittensor-specific one). Converted via the same whole/remainder split
to_tao_exact uses elsewhere in this codebase, to avoid the >2**53 rao
double-rounding a naive float(rao)/1e9 would introduce for real whale
balances.

Run: uv run --with bittensor python scripts/fetch-account-balances.py
"""
import argparse
import json
import os
import sys
import time

OUT = os.environ.get("ACCOUNT_BALANCES_JSON", "dist/account-balances.json")
PROGRESS_INTERVAL_S = 30
QUERY_MAP_PAGE_SIZE = 1000
# Above this fraction of scanned entries erroring out (malformed AccountInfo,
# a decode failure), treat the run as systemically broken rather than
# publishing a mostly-empty snapshot as if it were complete.
MAX_ERROR_RATE = 0.5


def _unwrap(value):
    return value.value if hasattr(value, "value") else value


def rao_to_tao_exact(rao):
    """Exact rao->TAO conversion for a plain int, without the double-
    rounding a naive float(rao)/1e9 introduces above 2**53 rao (~9M TAO) --
    same whole/remainder split fetch-metagraph-native.py's to_tao_exact uses
    for Balance objects, applied directly to a raw int since System::Account
    values are plain frame-system u128s, not bittensor Balance instances."""
    if rao is None:
        return None
    try:
        rao = int(rao)
    except (TypeError, ValueError):
        return None
    whole = rao // 1_000_000_000
    remainder = (rao % 1_000_000_000) / 1e9
    return whole + remainder


def main():
    import bittensor as bt  # lazy: matches every other chain-direct fetch script

    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--network", default=os.environ.get("SUBTENSOR_RPC_URL") or "finney"
    )
    args = parser.parse_args()

    s = bt.SubtensorApi(network=args.network)

    t0 = time.time()
    last_report = t0
    captured_at = int(time.time() * 1000)

    rows = []
    errors = []
    scanned = 0
    for key, value in s.substrate.query_map(
        "System", "Account", page_size=QUERY_MAP_PAGE_SIZE
    ):
        scanned += 1
        try:
            ss58 = str(_unwrap(key))
            info = _unwrap(value)
            data = _unwrap(info["data"]) if isinstance(info, dict) else info.data
            free_rao = int(_unwrap(data["free"] if isinstance(data, dict) else data.free))
            reserved_rao = int(
                _unwrap(data["reserved"] if isinstance(data, dict) else data.reserved)
            )
        except Exception as exc:  # noqa: BLE001 -- one bad row must not sink the run
            errors.append(f"{exc}")
            continue

        # Existential-deposit-only/reaped accounts carry a real System::Account
        # entry with zero free and zero reserved (e.g. a sufficients-only
        # entry) -- skip rather than publish a meaningless all-zero row.
        if free_rao == 0 and reserved_rao == 0:
            continue

        rows.append(
            {
                "ss58": ss58,
                "free_tao": rao_to_tao_exact(free_rao),
                "reserved_tao": rao_to_tao_exact(reserved_rao),
                "captured_at": captured_at,
            }
        )

        now = time.time()
        if now - last_report >= PROGRESS_INTERVAL_S:
            sys.stderr.write(
                f"fetch-account-balances: {scanned} accounts scanned, "
                f"{len(rows)} nonzero-balance row(s) so far, "
                f"{now - t0:.0f}s elapsed\n"
            )
            last_report = now

    os.makedirs(os.path.dirname(OUT) or ".", exist_ok=True)
    with open(OUT, "w") as fh:
        json.dump(rows, fh)
    sys.stderr.write(
        f"fetch-account-balances: wrote {len(rows)} nonzero-balance row(s) "
        f"from {scanned} scanned account(s) ({len(errors)} error(s)) in "
        f"{time.time() - t0:.0f}s -> {OUT}\n"
    )
    if errors:
        sys.stderr.write(
            "fetch-account-balances: sample errors: "
            + "; ".join(errors[:5])
            + "\n"
        )
    if scanned and len(errors) > scanned * MAX_ERROR_RATE:
        sys.stderr.write(
            f"fetch-account-balances: error rate {len(errors)}/{scanned} "
            f"exceeds {MAX_ERROR_RATE:.0%} -- treating as a systemic "
            "failure, not a partial snapshot\n"
        )
        sys.exit(1)
    if not scanned:
        sys.exit(1)


if __name__ == "__main__":
    main()
