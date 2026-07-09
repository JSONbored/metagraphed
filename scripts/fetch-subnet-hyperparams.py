#!/usr/bin/env python3
"""First-party subnet hyperparameters fetcher (#4303/1.2) — chain-direct via the
Bittensor SDK, the largest confirmed capture gap found in the 2026-07-08 block-
explorer research pass (docs/block-explorer-data-model.md). Unlike the per-UID
metagraph fetch (fetch-metagraph-native.py, ONE bulk get_all_metagraphs_info call
for every subnet), get_subnet_hyperparameters has no bulk variant — this makes one
call PER active subnet (~129 today, same cost class as the metagraph fetch's
per-subnet storage reads). Emits one row per netuid to dist/metagraph-subnet-
hyperparams.json — the same unsigned-local-JSON convention refresh-metagraph.yml's
sign-and-stage job expects (scripts/sign-staged-neurons.mjs + wrangler r2 object
put); refresh-subnet-hyperparams.yml (#4306/1.3) wires the matching workflow.

Field mapping + versioning verified live against finney, 2026-07-08 (spec_version
424, get_subnet_hyperparams_v3 — the current non-deprecated variant; the SDK's
get_subnet_hyperparameters() tries _v3 -> _v2 -> the base method internally, so
this script never picks a version itself). Sources: installed bittensor==10.5.0
(core/subtensor.py:4040-4063, core/chain_data/subnet_hyperparameters.py:1-164);
live RPC probe against netuids 0/1/8/64.

Units:
  *_ratio fields = on-chain U16 (0..65535) / 65535, matching the u16_ratio
    convention already used for rank/validator_trust in fetch-metagraph-native.py.
  min_burn_tao/max_burn_tao = on-chain rao (plain int, NOT a Balance object here —
    the SDK's TaoBalance-tagged fields decode via a raw-int fallback) / 1e9, split
    before dividing like to_tao_exact to avoid float rounding above 2**53 rao.
  burn_increase_mult / alpha_sigmoid_steepness = already float-decoded fixed-point
    on the SDK side (U64F64 / I32F32) — passed through as-is.
  bonds_moving_avg is emitted RAW (no ratio conversion): the research spike could
    not confirm its exact scaling constant against the pallet source — better to
    ship the true on-chain integer than a guessed conversion. Confirm before
    adding a *_ratio column for it.
  min_childkey_take_ratio applies the same U16-ratio convention as the other
    confirmed ratio fields, but was not itself directly observed as non-null on
    the probed netuids — presumed, not confirmed, from the shared pallet encoding.
  rho / difficulty / min_difficulty / max_difficulty / adjustment_interval /
    adjustment_alpha are OMITTED — confirmed None (dead PoW/difficulty-era fields)
    on every probed netuid; do not add columns for these.

Run: uv run --with bittensor python scripts/fetch-subnet-hyperparams.py
"""
import argparse
import json
import os
import sys
import time

OUT = os.environ.get(
    "SUBNET_HYPERPARAMS_JSON", "dist/metagraph-subnet-hyperparams.json"
)


def to_float(value):
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def u16_ratio(value):
    """A U16 (0..65535) chain field expressing a 0..1 ratio — the same encoding
    already used for rank/validator_trust in fetch-metagraph-native.py."""
    if value is None:
        return None
    try:
        n = int(value)
    except (TypeError, ValueError):
        return None
    return round(n / 65535, 9)


def rao_to_tao_exact(rao):
    """Convert a plain rao int to TAO without routing the whole integer through
    a single double-precision division, which silently loses low-order digits
    above 2**53 rao (~9M TAO) — the same exact-split technique as
    fetch-metagraph-native.py's to_tao_exact, but for a bare int rather than a
    Balance object (TaoBalance-tagged hyperparameter fields decode to a raw int,
    not a Balance, per the field-mapping research)."""
    if rao is None:
        return None
    try:
        rao = int(rao)
    except (TypeError, ValueError):
        return None
    whole = rao // 1_000_000_000
    remainder = (rao % 1_000_000_000) / 1e9
    return whole + remainder


def to_flag(value):
    """A chain Bool hyperparameter -> D1 INTEGER 0/1, matching the active/
    validator_permit/is_immunity_period convention in fetch-metagraph-native.py."""
    return 1 if value else 0


def main():
    import bittensor as bt  # lazy: keeps this module loadable (e.g. for unit
    # tests) without the heavy SDK installed, matching fetch-events.py's/
    # fetch-metagraph-native.py's convention.

    parser = argparse.ArgumentParser()
    # Same SUBTENSOR_RPC_URL convention as fetch-metagraph-native.py (ADR 0012):
    # unset -> "finney", set -> route through our own node without exposing it.
    parser.add_argument(
        "--network", default=os.environ.get("SUBTENSOR_RPC_URL") or "finney"
    )
    args = parser.parse_args()

    s = bt.SubtensorApi(network=args.network)

    # Reuse the bulk metagraph call purely to discover the active netuid set —
    # the same pattern fetch-native-subnets.py already uses for the same reason
    # (get_subnet_hyperparameters itself has no bulk/all-subnets variant).
    infos = s.metagraphs.get_all_metagraphs_info(all_mechanisms=True)
    netuids = sorted(
        {
            int(info.netuid)
            for info in infos
            if int(getattr(info, "mechid", 0) or 0) == 0
        }
    )

    captured_at = int(time.time() * 1000)
    rows = []
    errors = []
    if not netuids:
        # The downstream loader rejects empty snapshots; treat empty active-subnet
        # discovery as a fetch failure so the refresh workflow alerts instead of
        # signing and staging an unusable artifact.
        errors.append("no active netuids discovered")
    for netuid in netuids:
        try:
            hp = s.subnets.get_subnet_hyperparameters(netuid=netuid)
        except Exception as exc:
            # This fetch feeds a full-snapshot loader that prunes absent netuids.
            # A per-netuid failure must therefore fail the run instead of
            # authenticating a partial snapshot as complete.
            errors.append(f"netuid={netuid}: {exc}")
            continue
        if hp is None:
            errors.append(f"netuid={netuid}: empty hyperparameters response")
            continue
        block_number = int(getattr(s.substrate, "block_number", 0) or 0)
        rows.append(
            {
                "netuid": netuid,
                "kappa_ratio": u16_ratio(getattr(hp, "kappa", None)),
                "immunity_period": getattr(hp, "immunity_period", None),
                "min_allowed_weights": getattr(hp, "min_allowed_weights", None),
                "max_weight_limit_ratio": u16_ratio(
                    getattr(hp, "max_weight_limit", None)
                ),
                "tempo": getattr(hp, "tempo", None),
                "weights_version": getattr(hp, "weights_version", None),
                "weights_rate_limit": getattr(hp, "weights_rate_limit", None),
                "activity_cutoff": getattr(hp, "activity_cutoff", None),
                "activity_cutoff_factor": getattr(
                    hp, "activity_cutoff_factor", None
                ),
                "registration_allowed": to_flag(
                    getattr(hp, "registration_allowed", False)
                ),
                "target_regs_per_interval": getattr(
                    hp, "target_regs_per_interval", None
                ),
                "min_burn_tao": rao_to_tao_exact(getattr(hp, "min_burn", None)),
                "max_burn_tao": rao_to_tao_exact(getattr(hp, "max_burn", None)),
                "burn_half_life": getattr(hp, "burn_half_life", None),
                "burn_increase_mult": to_float(
                    getattr(hp, "burn_increase_mult", None)
                ),
                # Raw on-chain integer, deliberately not scaled to a ratio — see
                # the module docstring.
                "bonds_moving_avg_raw": getattr(hp, "bonds_moving_avg", None),
                "max_regs_per_block": getattr(hp, "max_regs_per_block", None),
                "serving_rate_limit": getattr(hp, "serving_rate_limit", None),
                "max_validators": getattr(hp, "max_validators", None),
                "commit_reveal_period": getattr(hp, "commit_reveal_period", None),
                "commit_reveal_enabled": to_flag(
                    getattr(hp, "commit_reveal_weights_enabled", False)
                ),
                "alpha_high_ratio": u16_ratio(getattr(hp, "alpha_high", None)),
                "alpha_low_ratio": u16_ratio(getattr(hp, "alpha_low", None)),
                "liquid_alpha_enabled": to_flag(
                    getattr(hp, "liquid_alpha_enabled", False)
                ),
                "alpha_sigmoid_steepness": to_float(
                    getattr(hp, "alpha_sigmoid_steepness", None)
                ),
                "yuma_version": getattr(hp, "yuma_version", None),
                "subnet_is_active": to_flag(getattr(hp, "subnet_is_active", False)),
                "transfers_enabled": to_flag(
                    getattr(hp, "transfers_enabled", False)
                ),
                "bonds_reset_enabled": to_flag(
                    getattr(hp, "bonds_reset_enabled", False)
                ),
                "user_liquidity_enabled": to_flag(
                    getattr(hp, "user_liquidity_enabled", False)
                ),
                "owner_cut_enabled": to_flag(
                    getattr(hp, "owner_cut_enabled", False)
                ),
                "owner_cut_auto_lock_enabled": to_flag(
                    getattr(hp, "owner_cut_auto_lock_enabled", False)
                ),
                # Presumed U16-ratio convention, not directly confirmed non-null
                # on the probed netuids — see the module docstring.
                "min_childkey_take_ratio": u16_ratio(
                    getattr(hp, "min_childkey_take", None)
                ),
                "block_number": block_number,
                "captured_at": captured_at,
            }
        )

    os.makedirs(os.path.dirname(OUT) or ".", exist_ok=True)
    with open(OUT, "w") as fh:
        json.dump(rows, fh)
    sys.stderr.write(
        f"wrote {len(rows)} subnet hyperparameter row(s) "
        f"({len(errors)} error(s)) -> {OUT}\n"
    )
    for err in errors:
        sys.stderr.write(f"  {err}\n")
    if errors or len(rows) != len(netuids):
        sys.exit(1)


if __name__ == "__main__":
    main()
