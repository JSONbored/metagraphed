#!/usr/bin/env python3
"""Owner self-stake fetcher (#6507) -- fills a gap fetch-validator-nominator-
counts.py's Alpha scan structurally cannot: a hotkey owner's own stake on
that same hotkey frequently has NO explicit SubtensorModule::Alpha entry
(raw `{"bits": 0}`) even when it holds real, substantial stake. Live-verified
2026-07-17 against the 3 real SN1 validator coldkeys from #6507's original
report: for hotkey 5Ft5kRgKDFafWX8mHneYqi44z8J3PGDguVjYnEADxjVJPTih (owned by
5FHxxe8ZKYaNmGcSLdG5ekxXeZDhQnk9cbpHdsJW8RunGpSs), ~91% of its ~80 registered
(hotkey, netuid) pairs showed raw ownAlphaBits=0 while the SDK's OWN blessed
accessor (`SubtensorApi(...).staking.get_stake`, which calls
StakeInfoRuntimeApi::get_stake_info_for_hotkey_coldkey_netuid -- a RUNTIME
computation, not a raw storage read) reported real, nonzero self-stake for
those same pairs (e.g. netuid=30: 2,130.66 alpha; netuid=101: 513.9 alpha).
There is no cheap storage-only way to reconstruct this -- TotalHotkeyAlpha's
relationship to the sum of per-coldkey Alpha shares is not a simple identity
(confirmed by direct reconciliation attempts), so the runtime API is the only
correct source.

Why this is its OWN script, not folded into fetch-validator-nominator-
counts.py: the runtime API is far more expensive per call than a raw storage
read (measured live against our own fullnode: ~127ms/call for get_stake() vs
~3.3ms/row for a plain query_map row). A full network-wide pass -- one
get_stake() call per registered (hotkey, netuid) pair -- cannot ride along in
that script's existing ~4-5min daily budget without blowing it out by more
than an order of magnitude. This runs on its own, much slower, WEEKLY cadence
instead -- the same reasoning this codebase already uses to split
validator-nominators out from refresh-metagraph, one cost tier further (see
that script's own docstring: "weekly is also fine if the source data doesn't
need to be fresher than that").

Emits ONLY the owner's own row per (hotkey, netuid) it's registered on --
third-party nominator positions are already correctly captured by
fetch-validator-nominator-counts.py's own Alpha scan and are deliberately NOT
duplicated here. Writes to the SAME nominator_positions table via the SAME
sync endpoint (distinct (coldkey, hotkey, netuid) primary key -- an owner row
never collides with a nominator row for the same hotkey, since a hotkey's
owner is never also a third-party delegator recorded via a different scan).

Known scope limitation (shared with fetch-validator-nominator-counts.py):
root (netuid 0) is excluded -- root stake is TAO-denominated 1:1 with no
alpha pool, so TotalHotkeyAlpha carries no root data at all.

Run: uv run --with bittensor python scripts/fetch-self-stake.py
"""
import argparse
import json
import os
import sys
import time

OUT = os.environ.get("SELF_STAKE_POSITIONS_JSON", "dist/self-stake-positions.json")
PROGRESS_INTERVAL_S = 30
# Above this fraction of registered pairs erroring out, treat the run as
# systemically broken (an RPC/network issue, not isolated transient blips)
# rather than publishing a mostly-empty snapshot as if it were complete.
MAX_ERROR_RATE = 0.5


def _unwrap(value):
    return value.value if hasattr(value, "value") else value


def _exact_ratio(numerator_rao, denominator_rao):
    """numerator/denominator as an exact-as-possible float, avoiding the
    double-rounding fetch-metagraph-native.py's to_tao_exact guards against
    for the numerator specifically (both sides are already same-scale raw
    integers here, so no unit conversion is needed before dividing)."""
    if denominator_rao <= 0:
        return 0.0
    return numerator_rao / denominator_rao


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

    # 1. hotkey -> owner coldkey (SubtensorModule::Owner) -- one entry per
    # registered hotkey, a much smaller map than the full Alpha ledger.
    owner_by_hotkey = {}
    for key, value in s.substrate.query_map("SubtensorModule", "Owner"):
        owner_by_hotkey[str(_unwrap(key))] = str(_unwrap(value))
    sys.stderr.write(
        f"fetch-self-stake: {len(owner_by_hotkey)} owner(hotkey) entries, "
        f"{time.time() - t0:.0f}s elapsed\n"
    )

    # 2. Every registered (hotkey, netuid) pair with its TOTAL alpha (raw,
    # already in the same 1e-9-scaled units as a Balance's .rao -- verified
    # live 2026-07-17: a TotalHotkeyAlpha of 1861288182 matched get_stake()
    # reporting exactly 1.861288182 for that same pair). This is NOT the
    # same fixed-point U64F64 "bits" representation Alpha's own per-coldkey
    # share ledger uses -- the two are unrelated encodings of unrelated
    # accounting concepts, not two views of the same number.
    pairs = []
    for key, value in s.substrate.query_map("SubtensorModule", "TotalHotkeyAlpha"):
        hotkey, netuid = _unwrap(key)
        netuid = int(netuid)
        if netuid == 0:
            continue  # root: no alpha pool, see module docstring
        total_alpha_raw = int(_unwrap(value))
        if total_alpha_raw <= 0:
            continue
        hotkey = str(hotkey)
        owner = owner_by_hotkey.get(hotkey)
        if owner is None:
            continue
        pairs.append((hotkey, owner, netuid, total_alpha_raw))
    sys.stderr.write(
        f"fetch-self-stake: {len(pairs)} registered (hotkey, netuid) pairs "
        f"with a known owner, {time.time() - t0:.0f}s elapsed\n"
    )

    # 3. For each pair, the ONLY authoritative way to learn the owner's own
    # stake (see module docstring for why a raw storage read can't
    # substitute for this runtime-computed value).
    captured_at = int(time.time() * 1000)
    position_rows = []
    errors = []
    for i, (hotkey, owner, netuid, total_alpha_raw) in enumerate(pairs):
        try:
            owner_stake = s.staking.get_stake(
                coldkey_ss58=owner, hotkey_ss58=hotkey, netuid=netuid
            )
            owner_rao = int(owner_stake.rao)
        except Exception as exc:  # noqa: BLE001 -- one bad pair must not sink the run
            errors.append(f"hotkey={hotkey} netuid={netuid}: {exc}")
            continue
        if owner_rao > 0:
            # Clamp defensively: the TotalHotkeyAlpha read and this get_stake
            # call are two separate, non-atomic RPCs -- chain state can move
            # between them, and a fraction over 1.0 would silently inflate
            # stake_tao at the API-side join.
            fraction = min(_exact_ratio(owner_rao, total_alpha_raw), 1.0)
            if fraction > 0:
                position_rows.append(
                    {
                        "coldkey": owner,
                        "hotkey": hotkey,
                        "netuid": netuid,
                        "share_fraction": fraction,
                        "captured_at": captured_at,
                    }
                )
        now = time.time()
        if now - last_report >= PROGRESS_INTERVAL_S:
            sys.stderr.write(
                f"fetch-self-stake: {i + 1}/{len(pairs)} pairs, "
                f"{len(position_rows)} self-stake row(s) so far, "
                f"{now - t0:.0f}s elapsed\n"
            )
            last_report = now

    os.makedirs(os.path.dirname(OUT) or ".", exist_ok=True)
    with open(OUT, "w") as fh:
        json.dump(position_rows, fh)
    sys.stderr.write(
        f"fetch-self-stake: wrote {len(position_rows)} self-stake position "
        f"row(s) from {len(pairs)} registered pairs ({len(errors)} error(s)) "
        f"in {time.time() - t0:.0f}s -> {OUT}\n"
    )
    if errors:
        sys.stderr.write(
            "fetch-self-stake: sample errors: " + "; ".join(errors[:5]) + "\n"
        )
    if pairs and len(errors) > len(pairs) * MAX_ERROR_RATE:
        sys.stderr.write(
            f"fetch-self-stake: error rate {len(errors)}/{len(pairs)} exceeds "
            f"{MAX_ERROR_RATE:.0%} -- treating as a systemic failure, not a "
            "partial snapshot\n"
        )
        sys.exit(1)
    if not pairs:
        sys.exit(1)


if __name__ == "__main__":
    main()
