#!/usr/bin/env python3
"""First-party validator nominator-count + nominator-position fetcher
(#2549, #5233) — chain-direct via the Bittensor SDK's raw substrate
interface (not get_all_metagraphs_info(), which carries per-UID
stake/trust/emission but no nominator-side data at all).

Scope and the reason this is its OWN script, not folded into
fetch-metagraph-native.py: both outputs below come from the SAME source --
SubtensorModule::Alpha, a triple-key (hotkey, coldkey, netuid) -> shares
map with NO way to query "just the entries for a given hotkey" or "just the
entries for a given delegator" in bulk cheaper than a full scan, and no
network-wide aggregate RPC exists for either question. The only correct
approach is a SINGLE full scan, from which BOTH outputs are derived in one
pass -- doubling the ~4-5 minute scan to answer a second question from the
same table would be wasteful and this repo's own convention (see
neurons/neuron_daily sharing one refresh-metagraph pass) is to derive every
answer a single scan can support from that one pass.

Empirically measured live against the fullnode, 2026-07-14 (bittensor SDK,
same pinned version this container ships): a full scan via
query_map(page_size=1000) at a sustained ~3000-3100 rows/sec completed in
249s (~4.2 min), covering 762,577 total Alpha rows and converging on 112,552
distinct hotkeys holding any nonzero stake network-wide (max single-hotkey
nominator count observed: 7266). That's short enough to run daily, but still
far more than the ~30-60s refresh-metagraph cron budget can absorb alongside
its existing work -- this runs on its own, separate lower-frequency cadence
(daily is comfortable; weekly is also fine if the source data doesn't need
to be fresher than that) with a generous timeout headroom over the observed
~4-5 minutes.

Deliberately does NOT filter to only currently-known validator-permit
hotkeys: doing so would need a second RPC round trip (a metagraph fetch) to
know the validator set in advance, adding complexity and a cross-referencing
step to a script whose dominant cost and risk is already the scan duration
itself. This script instead emits a nominator_count row for every hotkey it
encounters with at least one nonzero stake relationship (validator or not);
the API-side join (buildGlobalValidators) only looks up rows for hotkeys it
already knows are validators, so a row here for a hotkey without validator
status is simply unused, not incorrect.

Units (#5233, live-verified 2026-07-14 against the fullnode, IMPORTANT --
do not assume Alpha's raw value is already TAO-denominated):
Alpha's stored value is a fixed-point U64F64 SHARE count (a `{"bits": N}`
struct; the true value is bits / 2**64), not a TAO/alpha amount. Cross-
checked live: for one real subnet's top hotkey, summing every delegator's
Alpha share (bits/2**64) across that (hotkey, netuid) came to ~15,528x that
hotkey's reported total stake_tao for the same netuid -- confirming these
are pool-internal accounting shares that must be normalized by the TOTAL
shares outstanding for that (hotkey, netuid) pair, not read as TAO
directly. This script therefore emits a dimensionless share_fraction
(this delegator's shares / all delegators' shares for that hotkey+netuid)
per row rather than attempting a TAO conversion here -- the API-side join
(src/account-nominator-positions.mjs) multiplies that fraction by the
ALREADY-INGESTED neurons.stake_tao for the same (hotkey, netuid) at serve
time, mirroring the nominator_count/apy_estimate join pattern exactly. By
construction, one hotkey's share_fractions across all its coldkeys sum to
exactly 1.0, so the per-coldkey breakdown of its stake_tao is invariant-
checkable.

Known scope limitation, root (netuid 0) is NOT covered: every Alpha entry
observed at netuid 0 in this same scan was bits=0 (live-verified,
2026-07-14) -- root stake is TAO-denominated 1:1 with no alpha pool
(#2550), so it isn't tracked via this share-based map at all. Root
per-coldkey positions would need a different chain query (not yet
identified) and are out of scope for this script; buildAccountPositions'
own callers should not assume completeness for root-only delegators.

Run: uv run --with bittensor python scripts/fetch-validator-nominator-counts.py
"""
import argparse
import json
import os
import sys
import time

OUT = os.environ.get(
    "VALIDATOR_NOMINATOR_COUNTS_JSON",
    "dist/validator-nominator-counts.json",
)
POSITIONS_OUT = os.environ.get(
    "NOMINATOR_POSITIONS_JSON",
    "dist/nominator-positions.json",
)
# query_map's own page size, not this script's row cap -- kept as a named
# constant since it's the one knob likely to need tuning against RPC latency
# on a real full scan (smaller = more round trips, larger = bigger responses).
PAGE_SIZE = 1000
PROGRESS_INTERVAL_S = 30
FIXED_POINT_SCALE = 2**64


def _unpack_key(key):
    """substrate-interface sometimes wraps a decoded NMap key in a ScaleType
    with a `.value` attribute and sometimes hands back the plain decoded
    tuple directly, depending on version/call path (live-verified both shapes
    against the installed SDK, 2026-07-14) -- never assume either alone."""
    return key.value if hasattr(key, "value") else key


def _unpack_shares(value):
    """Alpha's stored value is a fixed-point U64F64 struct ({"bits": N}) in
    every live-verified shape so far, but defensively accept a bare int too
    (mirrors _unpack_key's own defensive dual-shape handling)."""
    v = value.value if hasattr(value, "value") else value
    bits = v["bits"] if isinstance(v, dict) else v
    return int(bits)


def main():
    import bittensor as bt  # lazy: matches every other chain-direct fetch
    # script's convention (fetch-events.py / fetch-metagraph-native.py /
    # fetch-account-identity.py) -- keeps this module loadable without the
    # heavy SDK installed.

    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--network", default=os.environ.get("SUBTENSOR_RPC_URL") or "finney"
    )
    args = parser.parse_args()

    s = bt.SubtensorApi(network=args.network)

    t0 = time.time()
    last_report = t0
    row_count = 0
    nominators = {}  # hotkey (ss58 str) -> set of coldkey (ss58 str) values holding stake on it
    # (hotkey, netuid) -> {coldkey: shares(bits)}, the raw share ledger this
    # scan's second output (nominator positions, #5233) is normalized from
    # once the true per-(hotkey,netuid) total share count is known -- can't
    # compute share_fraction row-by-row during the scan since later rows for
    # the same (hotkey, netuid) would still change the denominator.
    shares_by_hotkey_netuid = {}
    for key, value in s.substrate.query_map(
        "SubtensorModule", "Alpha", page_size=PAGE_SIZE
    ):
        row_count += 1
        hotkey, coldkey, netuid = _unpack_key(key)
        hotkey, coldkey = str(hotkey), str(coldkey)
        nominators.setdefault(hotkey, set()).add(coldkey)
        shares = _unpack_shares(value)
        # netuid 0 (root) Alpha entries are always 0 (live-verified,
        # 2026-07-14) -- root isn't share-tracked at all, so skip rather than
        # store a permanently-zero, useless ledger entry.
        if netuid != 0 and shares > 0:
            shares_by_hotkey_netuid.setdefault((hotkey, netuid), {})[coldkey] = shares
        now = time.time()
        if now - last_report >= PROGRESS_INTERVAL_S:
            sys.stderr.write(
                f"fetch-validator-nominator-counts: {row_count} Alpha rows, "
                f"{len(nominators)} distinct hotkeys, {now - t0:.0f}s elapsed\n"
            )
            last_report = now

    captured_at = int(time.time() * 1000)
    rows = [
        {
            "hotkey": hotkey,
            "nominator_count": len(coldkeys),
            "captured_at": captured_at,
        }
        for hotkey, coldkeys in nominators.items()
    ]

    position_rows = []
    for (hotkey, netuid), coldkey_shares in shares_by_hotkey_netuid.items():
        total_shares = sum(coldkey_shares.values())
        for coldkey, shares in coldkey_shares.items():
            position_rows.append(
                {
                    "coldkey": coldkey,
                    "hotkey": hotkey,
                    "netuid": netuid,
                    "share_fraction": shares / total_shares,
                    "captured_at": captured_at,
                }
            )

    os.makedirs(os.path.dirname(OUT) or ".", exist_ok=True)
    with open(OUT, "w") as fh:
        json.dump(rows, fh)
    os.makedirs(os.path.dirname(POSITIONS_OUT) or ".", exist_ok=True)
    with open(POSITIONS_OUT, "w") as fh:
        json.dump(position_rows, fh)
    sys.stderr.write(
        f"fetch-validator-nominator-counts: wrote {len(position_rows)} "
        f"nominator-position row(s) -> {POSITIONS_OUT}\n"
    )
    sys.stderr.write(
        f"fetch-validator-nominator-counts: wrote {len(rows)} hotkey row(s) "
        f"from {row_count} Alpha entries in {time.time() - t0:.0f}s -> {OUT}\n"
    )
    if not rows:
        sys.exit(1)


if __name__ == "__main__":
    main()
