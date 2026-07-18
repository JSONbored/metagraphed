#!/usr/bin/env python3
"""Subnet-ownership-contest lock fetcher (#6638, conviction/ownership-contest
tracker epic #4302) -- chain-direct via the Bittensor SDK, feeding the
subnet_locks table the live conviction-leaderboard route reads. See
docs/conviction-lock-mechanism.md for the on-chain mechanism this captures:
a permissionless, conviction-weighted contest that runs continuously per
subnet -- any account can lock alpha to a hotkey to build "conviction", and
once a challenger's rolled conviction overtakes the incumbent owner's,
ownership transfers automatically (no vote, no owner cooperation required).

Captures FOUR storage maps, each network-wide in a single query_map pass (no
per-netuid looping -- confirmed live 2026-07-18 this covers the whole chain
in one prefix scan per map, ~180 total rows network-wide today):
  - HotkeyLock          (is_owner=False, is_perpetual=True)  -- non-owner
    perpetual (non-decaying) sub-aggregate per (netuid, hotkey).
  - DecayingHotkeyLock  (is_owner=False, is_perpetual=False) -- non-owner
    decaying sub-aggregate per (netuid, hotkey). SEPARATE from HotkeyLock
    above -- verified live these are genuinely independent entries for the
    same hotkey, not duplicates; the read side must roll each forward on
    its own decay/non-decay rule, never sum them raw first.
  - OwnerLock           (is_owner=True,  is_perpetual=True)  -- the current
    subnet owner's own perpetual sub-aggregate, keyed by netuid only (no
    hotkey component on-chain); resolved to a concrete hotkey here via
    SubnetOwnerHotkey so every row in the output has one.
  - DecayingOwnerLock   (is_owner=True,  is_perpetual=False) -- ditto,
    decaying sub-aggregate.

conviction is emitted as a DECIMAL STRING, not a JSON number: it's a raw
U64F64 (u128) fixed-point value straight off the chain (verified live:
substrate-interface exposes it as {'bits': <u128 int>}), which exceeds both
JS's safe-integer range and a JSON number's exact-precision guarantee.
Python's arbitrary-precision int -> str(...) round-trips it exactly; the
sync endpoint stores it in a Postgres NUMERIC column, and the read-side API
divides by 2**64 for the float value at request time (never stored as a
lossy float).

UnlockRate/MaturityRate (needed to roll a snapshot forward to "now") are
NOT captured here -- they're two plain StorageValues, cheap enough to
live-query directly in the read-side Worker route on every request (same
convention as every other governance-adjustable pallet bound already
live-queried in this codebase, e.g. #6343's network-parameters route).
Confirmed live 2026-07-18 they can genuinely differ from each other (and
from any previously-assumed "default") -- MaturityRate read 311622 against
UnlockRate's 934866 -- so baking either into this snapshot would go stale
silently the moment governance adjusts one.

Run: uv run --with bittensor python scripts/fetch-subnet-locks.py
"""
import argparse
import json
import os
import sys
import time

OUT = os.environ.get("SUBNET_LOCKS_JSON", "dist/subnet-locks.json")
MAX_NETUID = 65_535


def _unwrap(value):
    return value.value if hasattr(value, "value") else value


def _conviction_bits_str(value):
    """The raw U64F64 u128 bits as an exact decimal string -- never routed
    through a float, which would silently lose precision above 2**53."""
    bits = value.get("bits") if isinstance(value, dict) else None
    if bits is None:
        return "0"
    return str(int(bits))


def _row(netuid, hotkey, is_owner, is_perpetual, lock_state, captured_at):
    return {
        "netuid": int(netuid),
        "hotkey": str(hotkey),
        "is_owner": bool(is_owner),
        "is_perpetual": bool(is_perpetual),
        "locked_mass": int(lock_state.get("locked_mass") or 0),
        "conviction_bits": _conviction_bits_str(lock_state.get("conviction")),
        "last_update": int(lock_state.get("last_update"))
        if lock_state.get("last_update") is not None
        else None,
        "captured_at": captured_at,
    }


def main():
    import bittensor as bt  # lazy: matches every other chain-direct fetch script

    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--network", default=os.environ.get("SUBTENSOR_RPC_URL") or "finney"
    )
    args = parser.parse_args()

    s = bt.SubtensorApi(network=args.network)
    substrate = s.substrate

    t0 = time.time()
    captured_at = int(time.time() * 1000)
    rows = []

    # 1-2. Non-owner sub-aggregates: (netuid, hotkey) keyed directly, no
    # resolution needed.
    for storage_name, is_perpetual in (
        ("HotkeyLock", True),
        ("DecayingHotkeyLock", False),
    ):
        n = 0
        for key, value in substrate.query_map(
            "SubtensorModule", storage_name, page_size=100
        ):
            netuid_raw, hotkey_raw = key
            netuid = int(_unwrap(netuid_raw))
            hotkey = str(_unwrap(hotkey_raw))
            if not (0 <= netuid <= MAX_NETUID):
                continue
            lock_state = _unwrap(value)
            rows.append(
                _row(netuid, hotkey, False, is_perpetual, lock_state, captured_at)
            )
            n += 1
        sys.stderr.write(
            f"fetch-subnet-locks: {storage_name}: {n} entries, "
            f"{time.time() - t0:.0f}s elapsed\n"
        )

    # 3-4. Owner sub-aggregates: keyed by netuid only on-chain -- resolve to
    # a concrete hotkey via SubnetOwnerHotkey (cached per netuid, since both
    # OwnerLock and DecayingOwnerLock need the same lookup).
    owner_hotkey_by_netuid = {}

    def resolve_owner_hotkey(netuid):
        if netuid not in owner_hotkey_by_netuid:
            try:
                r = substrate.query("SubtensorModule", "SubnetOwnerHotkey", params=[netuid])
                owner_hotkey_by_netuid[netuid] = str(_unwrap(r)) if r is not None else None
            except Exception:  # noqa: BLE001 -- one bad netuid must not sink the run
                owner_hotkey_by_netuid[netuid] = None
        return owner_hotkey_by_netuid[netuid]

    for storage_name, is_perpetual in (
        ("OwnerLock", True),
        ("DecayingOwnerLock", False),
    ):
        n = 0
        skipped = 0
        for key, value in substrate.query_map(
            "SubtensorModule", storage_name, page_size=100
        ):
            netuid = int(_unwrap(key))
            if not (0 <= netuid <= MAX_NETUID):
                continue
            hotkey = resolve_owner_hotkey(netuid)
            if not hotkey:
                skipped += 1
                continue
            lock_state = _unwrap(value)
            rows.append(
                _row(netuid, hotkey, True, is_perpetual, lock_state, captured_at)
            )
            n += 1
        sys.stderr.write(
            f"fetch-subnet-locks: {storage_name}: {n} entries "
            f"({skipped} skipped, no resolvable owner hotkey), "
            f"{time.time() - t0:.0f}s elapsed\n"
        )

    os.makedirs(os.path.dirname(OUT) or ".", exist_ok=True)
    with open(OUT, "w") as fh:
        json.dump(rows, fh)
    sys.stderr.write(
        f"fetch-subnet-locks: wrote {len(rows)} row(s) in "
        f"{time.time() - t0:.0f}s -> {OUT}\n"
    )
    if not rows:
        # An empty network-wide result is suspicious (see module docstring --
        # ~180 rows observed live 2026-07-18) rather than a legitimately cold
        # store; treat it as a systemic failure, not a valid empty snapshot,
        # matching fetch-self-stake.py's own "no pairs -> exit 1" convention.
        sys.exit(1)


if __name__ == "__main__":
    main()
