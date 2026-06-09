#!/usr/bin/env python3
import argparse
import json
from datetime import datetime, timezone

import bittensor as bt


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
    parser = argparse.ArgumentParser(description="Fetch decoded Bittensor Finney subnet metadata.")
    parser.add_argument("--network", default="finney")
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
