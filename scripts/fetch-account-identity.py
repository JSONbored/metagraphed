#!/usr/bin/env python3
"""First-party personal (coldkey) identity fetcher (#4324/5.1) — chain-direct via
the Bittensor SDK. Distinct from subnet identity (SubtensorModule::SubnetIdentitiesV3,
scripts/fetch-native-subnets.py): this is the identity a coldkey attaches to itself
(display name, url, discord, etc.), keyed by AccountId not netuid.

Zero extra RPC cost: MetagraphInfo (the same object fetch-metagraph-native.py's one
get_all_metagraphs_info(all_mechanisms=True) call already returns) carries a
per-UID-aligned `identities: list[Optional[ChainIdentity]]` field that
fetch-metagraph-native.py doesn't currently read — decoded server-side by the SDK
into a typed dataclass (bittensor/core/chain_data/chain_identity.py), same as
`coldkeys`/`hotkeys`. This script makes its own get_all_metagraphs_info call (a
second, mostly-redundant ~10s round trip) rather than editing the proven neuron
pipeline in place, matching this repo's one-script-per-capture-concern convention
(fetch-subnet-hyperparams.py / fetch-native-subnets.py / fetch-events.py are each
separate scripts too, despite some overlapping RPC surface).

Scope: only coldkeys with an identity actually SET (identities[uid] is not None) —
most accounts never call set_identity, so this naturally stays small without an
explicit keyspace-enumeration limit. Deduped by coldkey (identity is attached to
the coldkey, not a specific hotkey/UID — the same coldkey can appear at multiple
UIDs across subnets with an identical identity record).

Field shape verified from the installed SDK's ChainIdentity dataclass
(bittensor/core/chain_data/chain_identity.py, bittensor==10.4.0, matching the
pinned version in refresh-metagraph.yml): name, url, github, image, discord,
description, additional — all plain strings, empty ("") when a field was never
set on-chain (not None; only the whole ChainIdentity entry is Optional).

Run: uv run --with bittensor python scripts/fetch-account-identity.py
"""
import argparse
import json
import os
import sys
import time

OUT = os.environ.get("ACCOUNT_IDENTITY_JSON", "dist/metagraph-account-identity.json")


def _at(arr, i):
    return arr[i] if i < len(arr) else None


def blank_to_null(value):
    """The SDK decodes an unset ChainIdentity string field as "", not None —
    normalize to null so the D1/API contract matches every other nullable text
    field in this codebase rather than leaking chain-encoding empty strings."""
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped or None


def main():
    import bittensor as bt  # lazy: keeps this module loadable (e.g. for unit
    # tests) without the heavy SDK installed, matching fetch-events.py's/
    # fetch-metagraph-native.py's convention.

    parser = argparse.ArgumentParser()
    # Default from the SUBTENSOR_RPC_URL env (the hidden chain-RPC secret; ADR
    # 0012), falling back to "finney" when unset — same convention as every
    # other chain-direct fetch script.
    parser.add_argument(
        "--network", default=os.environ.get("SUBTENSOR_RPC_URL") or "finney"
    )
    args = parser.parse_args()

    s = bt.SubtensorApi(network=args.network)
    infos = s.metagraphs.get_all_metagraphs_info(all_mechanisms=True)

    # Dedupe by netuid (mechid 0 is canonical), matching fetch-metagraph-native.py.
    by_netuid = {}
    for info in infos:
        nu = int(info.netuid)
        mechid = int(getattr(info, "mechid", 0) or 0)
        if mechid == 0 or nu not in by_netuid:
            by_netuid[nu] = info

    captured_at = int(time.time() * 1000)
    identities_by_account = {}
    for netuid in sorted(by_netuid):
        info = by_netuid[netuid]
        coldkeys = list(getattr(info, "coldkeys", []) or [])
        identities = list(getattr(info, "identities", []) or [])
        n = len(coldkeys)
        for uid in range(n):
            account = _at(coldkeys, uid)
            identity = _at(identities, uid)
            if not account or identity is None or account in identities_by_account:
                continue
            identities_by_account[account] = {
                "account": account,
                "name": blank_to_null(getattr(identity, "name", None)),
                "url": blank_to_null(getattr(identity, "url", None)),
                "github": blank_to_null(getattr(identity, "github", None)),
                "image": blank_to_null(getattr(identity, "image", None)),
                "discord": blank_to_null(getattr(identity, "discord", None)),
                "description": blank_to_null(getattr(identity, "description", None)),
                "additional": blank_to_null(getattr(identity, "additional", None)),
                "captured_at": captured_at,
            }

    rows = list(identities_by_account.values())
    os.makedirs(os.path.dirname(OUT) or ".", exist_ok=True)
    with open(OUT, "w") as fh:
        json.dump(rows, fh)
    sys.stderr.write(
        f"wrote {len(rows)} account identity row(s) across {len(by_netuid)} subnets -> {OUT}\n"
    )
    if not rows:
        sys.exit(1)


if __name__ == "__main__":
    main()
