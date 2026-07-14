#!/usr/bin/env python3
"""First-party validator nominator-count fetcher (#2549) — chain-direct via the
Bittensor SDK's raw substrate interface (not get_all_metagraphs_info(), which
carries per-UID stake/trust/emission but no nominator-side data at all).

Scope and the reason this is its OWN script, not folded into
fetch-metagraph-native.py: a validator's nominator count is "how many distinct
coldkeys currently hold a nonzero stake position on this hotkey, across every
subnet" — that information lives in SubtensorModule::Alpha, a triple-key
(hotkey, coldkey, netuid) -> shares map with NO way to query "just the entries
for hotkey X" in bulk cheaper than iterating a hotkey-prefixed range, and no
network-wide "count distinct coldkeys per hotkey" RPC exists either. The only
correct approach is a SINGLE full scan of the map, accumulating a
hotkey -> set(coldkey) dict in memory, then counting each set's size.

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
# query_map's own page size, not this script's row cap -- kept as a named
# constant since it's the one knob likely to need tuning against RPC latency
# on a real full scan (smaller = more round trips, larger = bigger responses).
PAGE_SIZE = 1000
PROGRESS_INTERVAL_S = 30


def _unpack_key(key):
    """substrate-interface sometimes wraps a decoded NMap key in a ScaleType
    with a `.value` attribute and sometimes hands back the plain decoded
    tuple directly, depending on version/call path (live-verified both shapes
    against the installed SDK, 2026-07-14) -- never assume either alone."""
    return key.value if hasattr(key, "value") else key


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
    for key, _value in s.substrate.query_map(
        "SubtensorModule", "Alpha", page_size=PAGE_SIZE
    ):
        row_count += 1
        hotkey, coldkey, _netuid = _unpack_key(key)
        hotkey, coldkey = str(hotkey), str(coldkey)
        nominators.setdefault(hotkey, set()).add(coldkey)
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

    os.makedirs(os.path.dirname(OUT) or ".", exist_ok=True)
    with open(OUT, "w") as fh:
        json.dump(rows, fh)
    sys.stderr.write(
        f"fetch-validator-nominator-counts: wrote {len(rows)} hotkey row(s) "
        f"from {row_count} Alpha entries in {time.time() - t0:.0f}s -> {OUT}\n"
    )
    if not rows:
        sys.exit(1)


if __name__ == "__main__":
    main()
