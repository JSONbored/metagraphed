#!/usr/bin/env python3
"""First-party personal (coldkey) identity fetcher (#4324/5.1) — chain-direct via
the Bittensor SDK. Distinct from subnet identity (SubtensorModule::SubnetIdentitiesV3,
scripts/fetch-native-subnets.py): this is the identity a coldkey attaches to itself
(display name, url, discord, etc.), keyed by AccountId not netuid.

Zero extra RPC cost: MetagraphInfo (the same object fetch-metagraph-native.py's one
get_all_metagraphs_info(all_mechanisms=True) call already returns) carries a
per-UID-aligned `identities` field that fetch-metagraph-native.py doesn't currently
read. This script makes its own get_all_metagraphs_info call (a second, mostly-
redundant ~10s round trip) rather than editing the proven neuron pipeline in place,
matching this repo's one-script-per-capture-concern convention (fetch-subnet-
hyperparams.py / fetch-native-subnets.py / fetch-events.py are each separate
scripts too, despite some overlapping RPC surface).

Scope — and its coverage gap: only coldkeys currently occupying at least one UID
slot in some subnet's canonical (mechid-0) metagraph are ever considered, because
`identities`/`coldkeys` are per-UID-aligned arrays sourced from the SAME neuron
enumeration as fetch-metagraph-native.py's own hotkeys/coldkeys. A coldkey that set
an identity but never registered a hotkey, or whose only hotkey has since
deregistered, is invisible to this script and never captured — there is currently
no other capture path in this repo that would catch it (confirmed: SubtensorModule::
IdentitiesV2 is a plain account-keyed storage map fully decoupled from neuron
registration on-chain, per get_delegate_identities() in the installed SDK, so the
gap is a real, permanent scoping choice of THIS script, not a chain limitation).
Accepted for #4325 because it still satisfies the issue's actual goal ("do not try
to enumerate the whole keyspace") via a different, lower-risk mechanism than the
issue's literal "scope to account_events" text (fetch scripts never read D1, and
account_events only retains 3 days — see the PR description for the full
rationale). #4328 (5.4, the serving route) and any future UI built on this table
inherit this same gap and should not assume "no row in account_identity" means "no
identity set."

Deduped by coldkey (identity is attached to the coldkey, not a specific hotkey/
UID — the same coldkey can appear at multiple UIDs across subnets with an
identical identity record; only the first occurrence is kept).

Field shape verified LIVE against finney, 2026-07-09 (bittensor==10.4.0, matching
the pinned version in refresh-metagraph.yml, via
SubtensorApi(network="finney").metagraphs.get_all_metagraphs_info(all_mechanisms=True)):
each non-null `identities[uid]` entry is a plain dict (NOT a ChainIdentity dataclass
instance, despite that class existing in the SDK for a different call path) with
keys name/url/github_repo/image/discord/description/additional — note `github_repo`,
not `github` (this script's own `account_identity.github` D1/API column keeps the
shorter name; only the SOURCE key differs). Re-verify this shape live before
bumping the pinned bittensor version — SubnetIdentitiesV3 (a different, subnet-
scoped identity item) has already been revised across three chain versions in this
codebase's history, so this personal-identity shape should not be assumed stable
either. Unset fields decode as "" (empty string), not None; only the whole entry is
Optional (None) when a coldkey never called set_identity.

Run: uv run --with bittensor python scripts/fetch-account-identity.py
"""
import argparse
import json
import os
import sys
import time

OUT = os.environ.get("ACCOUNT_IDENTITY_JSON", "dist/metagraph-account-identity.json")

# The chain's field name -> this script's output key. Only "github_repo" differs
# from the D1/API column name (see the module docstring's live-verified shape).
IDENTITY_FIELD_MAP = {
    "name": "name",
    "url": "url",
    "github_repo": "github",
    "image": "image",
    "discord": "discord",
    "description": "description",
    "additional": "additional",
}


def _at(arr, i):
    return arr[i] if i < len(arr) else None


def blank_to_null(value):
    """The SDK decodes an unset identity string field as "", not None —
    normalize to null so the D1/API contract matches every other nullable text
    field in this codebase rather than leaking chain-encoding empty strings."""
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped or None


def identity_fields(identity):
    """`identity` is a plain dict (live-verified shape, see the module
    docstring) — dict.get, not getattr, and github_repo maps to the shorter
    `github` output key. Never raises on an unexpected shape; a non-dict entry
    (a future SDK change) degrades to all-null fields rather than crashing the
    whole fetch."""
    getter = identity.get if isinstance(identity, dict) else lambda _k: None
    return {
        out_key: blank_to_null(getter(chain_key))
        for chain_key, out_key in IDENTITY_FIELD_MAP.items()
    }


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
                **identity_fields(identity),
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
