#!/usr/bin/env python3
import argparse
import json
import os
from datetime import datetime, timezone


def to_rao_exact(balance):
    """Extract the exact rao integer from a Balance, for sum-then-convert
    aggregation. Summing already-float-converted TAO values (the prior
    approach) compounds double-precision rounding across every per-UID entry
    before the total is even computed; summing rao (Python int, arbitrary
    precision) first and converting once at the end avoids that entirely
    (metagraphed#2921). Falls back to a best-effort rao estimate for plain
    numbers (never expected in practice — MetagraphInfo's per-UID arrays are
    Balance objects — but keeps this defensive like to_tao)."""
    if balance is None:
        return None
    try:
        return balance.rao
    except AttributeError:
        try:
            return int(round(float(balance) * 1_000_000_000))
        except (TypeError, ValueError):
            return None


def rao_to_tao_exact(rao):
    """Whole/remainder split so the integer TAO part is always exact, only
    crossing to a float for the sub-TAO remainder (metagraphed#2921)."""
    if rao is None:
        return None
    whole = rao // 1_000_000_000
    remainder = (rao % 1_000_000_000) / 1e9
    return whole + remainder


def to_tao_exact(balance):
    """Single-value equivalent of to_rao_exact + rao_to_tao_exact, for fields
    that aren't aggregated (registration_cost_tao, alpha_price_tao, pool
    reserves, etc.) — same exact-conversion guarantee as to_tao without ever
    routing through Balance.__float__/.tao internally (metagraphed#2921)."""
    return rao_to_tao_exact(to_rao_exact(balance))


def normalize_economics(info):
    """Per-subnet validator + economic snapshot from MetagraphInfo (#1009).

    Every value is already on the MetagraphInfo objects returned by
    get_all_metagraphs_info — no extra RPC. Per-uid arrays (validator_permit,
    total_stake) are aggregated into counts/sums; Balances are coerced to TAO.
    Best-effort: a missing/odd field becomes null rather than failing the fetch.
    """
    permits = list(getattr(info, "validator_permit", []) or [])
    validator_count = sum(1 for permit in permits if permit)
    num_uids = int(getattr(info, "num_uids", 0) or 0)
    # Sum in rao-integer space (exact, arbitrary precision), not float space —
    # summing already-converted TAO floats compounds rounding across every
    # per-UID entry before the subnet total is even computed (metagraphed#2921).
    stake_rao_values = [
        rao
        for rao in (
            to_rao_exact(entry) for entry in (getattr(info, "total_stake", []) or [])
        )
        if rao is not None
    ]
    total_stake_rao = sum(stake_rao_values) if stake_rao_values else None
    max_stake_rao = max(stake_rao_values) if stake_rao_values else None
    return {
        "max_uids": int(getattr(info, "max_uids", 0) or 0),
        "validator_count": validator_count,
        "max_validators": int(getattr(info, "max_validators", 0) or 0),
        "miner_count": max(0, num_uids - validator_count),
        "registration_allowed": bool(getattr(info, "registration_allowed", False)),
        "registration_cost_tao": to_tao_exact(getattr(info, "burn", None)),
        # dTAO emission is price-weighted: a subnet's share of network TAO
        # emission tracks its alpha price (moving_price), not the now-zeroed
        # subnet_emission/tao_in_emission fields. We capture the price here and
        # derive each subnet's emission_share at build time (price / Σ price).
        "alpha_price_tao": to_tao_exact(getattr(info, "moving_price", None)),
        "total_stake_tao": rao_to_tao_exact(total_stake_rao),
        "max_stake_tao": rao_to_tao_exact(max_stake_rao),
        "tao_in_pool_tao": to_tao_exact(getattr(info, "tao_in", None)),
        "alpha_in_pool": to_tao_exact(getattr(info, "alpha_in", None)),
        "alpha_out_pool": to_tao_exact(getattr(info, "alpha_out", None)),
        "subnet_volume_tao": to_tao_exact(getattr(info, "subnet_volume", None)),
        "owner_hotkey": str(getattr(info, "owner_hotkey", "") or "") or None,
        "owner_coldkey": str(getattr(info, "owner_coldkey", "") or "") or None,
    }


def normalize_info(info, mechanism_count, identity=None):
    netuid = int(info.netuid)
    raw_name = str(getattr(info, "name", "") or "").strip()
    name_quality = classify_name(raw_name, netuid)
    normalized = {
        "netuid": netuid,
        "name": raw_name or f"Subnet {netuid}",
        "raw_name": raw_name or None,
        "native_name_quality": name_quality,
        "symbol": str(getattr(info, "symbol", "") or ""),
        "status": "active",
        "subnet_type": "root" if netuid == 0 else "application",
        "block": int(getattr(info, "block", 0) or 0),
        "participant_count": int(getattr(info, "num_uids", 0) or 0),
        "tempo": int(getattr(info, "tempo", 0) or 0),
        "registered_at_block": int(getattr(info, "network_registered_at", 0) or 0),
        "mechanism_count": int(mechanism_count),
        "economics": normalize_economics(info),
    }
    if identity:
        normalized["chain_identity"] = identity
    return normalized


def normalize_identity(decoded):
    if not decoded:
        return None
    value = getattr(decoded, "value", decoded)
    if not value:
        return None

    def clean(field):
        raw = str(value.get(field, "") or "").strip()
        return raw or None

    identity = {
        "subnet_name": clean("subnet_name"),
        "github_repo": clean("github_repo"),
        "subnet_url": clean("subnet_url"),
        "discord": clean("discord"),
        "description": clean("description"),
        "logo_url": clean("logo_url"),
        "additional": clean("additional"),
        "contact_present": bool(clean("subnet_contact")),
        "source": "SubtensorModule.SubnetIdentitiesV3",
    }
    if not any(
        identity.get(field)
        for field in [
            "subnet_name",
            "github_repo",
            "subnet_url",
            "discord",
            "description",
            "logo_url",
            "additional",
        ]
    ):
        return None
    return identity


def classify_name(raw_name, netuid):
    if not raw_name:
        return "empty"
    normalized = raw_name.lower()
    if normalized in {"unknown", "none", "null", "n/a", "na", "unnamed"}:
        return "placeholder"
    if normalized == f"subnet {netuid}".lower():
        return "placeholder"
    return "chain"


def main():
    import bittensor as bt  # lazy: keeps this module loadable (e.g. for unit tests)
    # without the heavy SDK installed, matching fetch-events.py's convention.

    parser = argparse.ArgumentParser(description="Fetch decoded Bittensor Finney subnet metadata.")
    # Same SUBTENSOR_RPC_URL convention as fetch-metagraph-native.py (ADR 0012):
    # unset -> "finney", set -> route through our own node without exposing it.
    # This was the last chain-fetch script still hardcoded to the public
    # "finney" alias -- callers are refresh-native-snapshot.mjs (production
    # publish + the indexer-box data-refresh-economics systemd timer) and
    # sync-subnets.yml via scripts/sync-subnets.mjs's fetchNativeSnapshot().
    parser.add_argument(
        "--network", default=os.environ.get("SUBTENSOR_RPC_URL") or "finney"
    )
    args = parser.parse_args()

    subtensor = bt.SubtensorApi(network=args.network)
    infos = subtensor.metagraphs.get_all_metagraphs_info(all_mechanisms=True)

    by_netuid = {}
    mechanisms = {}
    for info in infos:
        netuid = int(info.netuid)
        mechid = int(getattr(info, "mechid", 0) or 0)
        mechanisms.setdefault(netuid, set()).add(mechid)
        if mechid == 0 or netuid not in by_netuid:
            by_netuid[netuid] = info

    identities = {}
    for netuid in sorted(by_netuid):
        try:
            identities[netuid] = normalize_identity(
                subtensor.substrate.query(
                    "SubtensorModule", "SubnetIdentitiesV3", [netuid]
                )
            )
        except Exception:
            identities[netuid] = None

    subnets = [
        normalize_info(
            by_netuid[netuid],
            len(mechanisms.get(netuid, {0})),
            identities.get(netuid),
        )
        for netuid in sorted(by_netuid)
    ]

    payload = {
        "schema_version": 1,
        "network": args.network,
        "captured_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "source": {
            "kind": "bittensor-sdk",
            "package": "bittensor",
            "version": getattr(bt, "__version__", "unknown"),
            "method": "SubtensorApi.metagraphs.get_all_metagraphs_info(all_mechanisms=True)",
            "identity_storage": "SubtensorModule.SubnetIdentitiesV3",
            "rpc_family": "subnetInfo",
        },
        "subnets": subnets,
    }

    print(json.dumps(payload, indent=2, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
