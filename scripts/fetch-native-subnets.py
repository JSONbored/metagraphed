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


# --- v440 emission-pipeline inputs (#8743) --------------------------------
#
# Ten per-subnet storage items and four network-level ones, read at ONE pinned
# block. One state_queryStorageAt covers all 128 netuids per item, so this is
# fourteen round trips per refresh, not fourteen hundred.
#
# #8743's version of this comment said the bulk get_all_metagraphs_info call
# already carried everything stage 1-8 needs beyond five items. That was true
# of the VALUES and false of the instants: the bulk call runs at its own
# height, so taking moving_price and registration_allowed from it left stage
# 1's input and stage 0's last gate straddling a block boundary from the reads
# they are combined with. #8744 pins both here. The gate parameters were not
# captured at any height at all.
#
# Keys are assembled from HARDCODED twox128 constants rather than hashed at
# runtime: the digests are fixed for the life of the pallet, and hashing them
# here would pull xxhash into an environment (uvx --from bittensor) that does
# not currently provide it. Same approach as src/subnet-burn.ts.

# twox128("SubtensorModule")
SUBTENSOR_PALLET_PREFIX = "658faa385070e074c85bf6b568cf0555"

# twox128(<item>) for each per-netuid map. All Identity-hashed, so the key
# suffix is the bare netuid as u16 little-endian with no hashing.
PIPELINE_STORAGE_ITEMS = {
    "miner_burned": "1eac6222ebba7feba4ca36a94736815e",
    "emission_enabled": "c97bb5c5631e5f593b5bd2da84a5fa16",
    "excess_tao": "857b0a5b920bc5e41cb0695a4b7d38e7",
    "first_emission_block": "e4cfee4e36f2419d8863a3fda65c428f",
    "subtoken_enabled": "e9348e9224ea06c9c2da12ce69e619c5",
    # The three emission channels are read from STORAGE rather than off
    # MetagraphInfo, even though the bulk call carries all three.
    # get_all_metagraphs_info runs at its own height, and mixing it with the
    # pinned reads above straddles a block boundary: measured 2026-07-31, the
    # mixed form put Σ(tao_in + excess) 898 rao off the issuance-derived block
    # emission, against 54 rao when every term comes from one block. Both are
    # small, but only the second is the fixed-point granularity -- the first is
    # just two different instants being added together.
    "tao_in_emission": "dd62ae7237581e8f6a684f1ecae06215",
    "alpha_in_emission": "1905df3b2516a166b6f9fba54fef1cd8",
    "alpha_out_emission": "25257fbc5458419b7bc7e8c44c521521",
    # STAGE 1'S INPUT AND STAGE 0'S LAST GATE, added by #8744 for the same
    # reason the three channels above are here rather than off MetagraphInfo.
    #
    # The bulk call carries both (as moving_price and registration_allowed) and
    # #8743 took them from there, which left the pipeline's MOST important
    # input -- the one every share is computed from -- at a different instant
    # than the reads it is combined with. #8749's harness reads both from
    # storage at its pinned block, so a surface built on the bulk-call values
    # would disagree with the harness that exists to hold it, and ADR 0023
    # decision 3 binds the two together.
    #
    # alpha_price_tao is deliberately NOT re-sourced from this: it is a
    # published field whose meaning ADR 0023 decision 1 fixes as-is. This is a
    # second, pinned reading for the pipeline alone.
    "moving_price": "1abf1b0f4fd14f7b72ee50f9d91d5915",
    "registration_allowed": "d5fe74da02c7b4bbb340fb368eee3e77",
}

# The gate's three parameters, read ONCE at the pinned block rather than per
# subnet. Not captured at all before #8744 -- the reconstruction needs theta at
# the height its inputs came from, and theta is recomputed by the runtime every
# 360 blocks, so a live read is the wrong number for 359 blocks out of 360.
GATE_PARAM_STORAGE_ITEMS = {
    "emission_gate_bar": "7c9b0d2964cc73e7519676c3cc4d5df9",
    "emission_bar_quantile": "a772007dde2ed63e0f21b5f9d7f16650",
    "emission_gate_exponent": "88c70e8dd0cf4af3aeb977ba2eee1df4",
}

# twox128("TotalIssuance"). The ONLY correct source for block emission -- the
# BlockEmission storage item reads a stale 1.0 TAO and must never be used.
TOTAL_ISSUANCE_STORAGE_KEY = (
    "0x" + SUBTENSOR_PALLET_PREFIX + "57c875e4cff74148e4628f264b974c80"
)

# MinerBurned is U96F32: a 128-bit word scaled by 2**32, NOT rao. Read as rao
# it lands ~4e9 out, which is the error that put an earlier reconstruction's
# mean share error at 5.4e-4 instead of 4.3e-8. Verified 2026-07-31 against
# finney: every non-zero value falls in (0, 1] with a maximum of exactly 1.0,
# which is what a fraction looks like and what a misscaled amount does not.
U96F32_SCALE = 2**32

# SubnetMovingPrice, EmissionGateBar and EmissionBarQuantile are U64F64: a
# 128-bit word scaled by 2**64, a DIFFERENT width from MinerBurned's U96F32
# above. Two fixed-point widths in one pallet is a trap -- reading MinerBurned
# at the wrong one is what put the first reconstruction at 5.4e-4 -- so they
# are two named scales, never one helper with a width argument.
U64F64_SCALE = 2**64


def _pipeline_storage_key(item_hash, netuid):
    """SubtensorModule.<item>[netuid] for an Identity-hashed u16 map."""
    suffix = int(netuid).to_bytes(2, "little").hex()
    return "0x" + SUBTENSOR_PALLET_PREFIX + item_hash + suffix


def decode_le_uint(raw, byte_len):
    """Little-endian unsigned integer from a 0x-prefixed hex storage value.

    Returns None for absent storage and for anything too short to be the
    value it claims to be -- a partial read must never be interpreted as a
    small number.
    """
    if not isinstance(raw, str) or not raw.startswith("0x"):
        return None
    body = raw[2:]
    if len(body) < byte_len * 2:
        return None
    try:
        return int.from_bytes(bytes.fromhex(body[: byte_len * 2]), "little")
    except ValueError:
        return None


def decode_optional_bool(raw, default):
    """A Substrate bool where ABSENCE IS MEANINGFUL, not missing data.

    SubnetEmissionEnabled defaults to TRUE -- absent storage is enabled and
    `0x00` is disabled -- so a naive "is the key set" check inverts the
    meaning. Measured on finney 2026-07-31: 57 of 127 subnets have no entry
    at all and are enabled BY DEFAULT, 24 are explicitly `0x01`, and 46 are
    explicitly `0x00`. Reading absence as false would have mislabelled 57
    live subnets.
    """
    if raw is None:
        return default
    if raw == "0x00":
        return False
    if raw == "0x01":
        return True
    return default


def fetch_pipeline_state(substrate, netuids):
    """The stage 0-8 inputs, all pinned to ONE block.

    Pinned deliberately: theta recomputes when block % 360 == 0, and a
    reconstruction assembled from reads straddling that boundary mismatches
    for reasons that have nothing to do with our arithmetic. One block hash
    for every read makes the whole observation reproducible at that height.
    """
    block_hash = substrate.get_chain_head()
    header = substrate.rpc_request("chain_getHeader", [block_hash])
    block_number = int(header["result"]["number"], 16)

    by_item = {}
    for item, item_hash in PIPELINE_STORAGE_ITEMS.items():
        keys = [_pipeline_storage_key(item_hash, netuid) for netuid in netuids]
        # One state_queryStorageAt per ITEM covers all 128 netuids.
        response = substrate.rpc_request("state_queryStorageAt", [keys, block_hash])
        values = {}
        for key, value in response["result"][0]["changes"]:
            # Recover the netuid from the key's own trailing u16, rather than
            # trusting the response to come back in request order.
            suffix = key[-4:]
            netuid = int.from_bytes(bytes.fromhex(suffix), "little")
            values[netuid] = value
        by_item[item] = values

    issuance_raw = substrate.rpc_request(
        "state_getStorage", [TOTAL_ISSUANCE_STORAGE_KEY, block_hash]
    )["result"]

    # The gate parameters, at the SAME block. `emission_gate_exponent` is
    # commonly unset, and that is not zero: unset means the runtime default
    # h = 3, while h = 0 would make the Hill gate 0.5 for every subnet. The
    # distinction is preserved as None here and resolved by the consumer.
    gate_params = {}
    for item, item_hash in GATE_PARAM_STORAGE_ITEMS.items():
        raw = substrate.rpc_request(
            "state_getStorage",
            ["0x" + SUBTENSOR_PALLET_PREFIX + item_hash, block_hash],
        )["result"]
        gate_params[item] = decode_le_uint(raw, 16)

    return {
        "block": block_number,
        "block_hash": block_hash,
        "total_issuance_rao": decode_le_uint(issuance_raw, 8),
        "gate_params": gate_params,
        "by_item": by_item,
    }


def normalize_pipeline(state, netuid):
    """One subnet's emission-pipeline inputs, decoded."""
    if not state:
        return {}
    # .get(item, {}) rather than [item]: a node that failed one of the
    # fourteen reads should cost that field, not the whole refresh. Same
    # posture as the absent-chain_state path below -- publish less, not
    # nothing.
    by_item = state["by_item"]

    def item(name):
        return by_item.get(name, {})

    miner_burned_bits = decode_le_uint(item("miner_burned").get(netuid), 16)
    first_emission = decode_le_uint(item("first_emission_block").get(netuid), 8)
    excess_rao = decode_le_uint(item("excess_tao").get(netuid), 8)
    tao_in_rao = decode_le_uint(item("tao_in_emission").get(netuid), 8)
    alpha_in_rao = decode_le_uint(item("alpha_in_emission").get(netuid), 8)
    alpha_out_rao = decode_le_uint(item("alpha_out_emission").get(netuid), 8)
    moving_price_bits = decode_le_uint(item("moving_price").get(netuid), 16)
    return {
        # Stage 1's input, read at the pinned block (#8744). Distinct from
        # alpha_price_tao, which carries the same chain item off the bulk call
        # at the bulk call's own height -- see PIPELINE_STORAGE_ITEMS. The
        # published field keeps its source and meaning; the pipeline gets an
        # input that shares an instant with everything it is combined with.
        "moving_price_pinned": (
            moving_price_bits / U64F64_SCALE
            if moving_price_bits is not None
            else None
        ),
        # Stage 0's last eligibility gate, pinned for the same reason.
        # Absent storage is FALSE here (unlike SubnetEmissionEnabled) --
        # NetworkRegistrationAllowed has no true-by-default behaviour.
        "registration_allowed_pinned": decode_optional_bool(
            item("registration_allowed").get(netuid), False
        ),
        # Stage 8: TAO injected into the subnet's own pool. Stage 7's chain
        # buys are excess_tao. Both are per-block, reservoir-smoothed and
        # cap-limited, so a point sample is noisy BY CONSTRUCTION -- the daily
        # rollup is the reportable figure, not this. Their SUM across subnets
        # is the quantity that must equal the issuance-derived block emission.
        "tao_in_emission_tao": rao_to_tao_exact(
            tao_in_rao if tao_in_rao is not None else 0
        ),
        # Alpha into the pool, and alpha to participants. alpha_out_emission
        # is NOT a constant 1.0 -- it is get_block_emission_for_issuance over
        # the subnet's own alpha issuance, a per-subnet halving curve. It
        # reads 1.0 for almost every subnet today only because none has
        # crossed its first threshold yet. Never hard-code it.
        "alpha_in_emission": rao_to_tao_exact(
            alpha_in_rao if alpha_in_rao is not None else 0
        ),
        "alpha_out_emission": rao_to_tao_exact(
            alpha_out_rao if alpha_out_rao is not None else 0
        ),
        # Zero is a real measurement here, never coerced to null: 57 subnets
        # legitimately read 0 on both TAO channels because they are disabled.
        "excess_tao": rao_to_tao_exact(excess_rao if excess_rao is not None else 0),
        "emission_enabled": decode_optional_bool(
            item("emission_enabled").get(netuid), True
        ),
        "subtoken_enabled": decode_optional_bool(
            item("subtoken_enabled").get(netuid), False
        ),
        "miner_burned_fraction": (
            None if miner_burned_bits is None else miner_burned_bits / U96F32_SCALE
        ),
        "first_emission_block": first_emission,
    }


def normalize_economics(info, pipeline=None):
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
        # emission tracks its alpha price (moving_price = SubnetMovingPrice,
        # stage 1's real input), not the zeroed subnet_emission field. We
        # capture the price here and derive each subnet's emission_share at
        # build time (price / Σ price).
        #
        # tao_in_emission is NOT zeroed and is captured below -- it reads
        # non-zero on every enabled subnet (verified against finney
        # 2026-07-31). An earlier version of this comment lumped it in with
        # subnet_emission, which is the one that actually reads zero.
        "alpha_price_tao": to_tao_exact(getattr(info, "moving_price", None)),
        "total_stake_tao": rao_to_tao_exact(total_stake_rao),
        "max_stake_tao": rao_to_tao_exact(max_stake_rao),
        "tao_in_pool_tao": to_tao_exact(getattr(info, "tao_in", None)),
        "alpha_in_pool": to_tao_exact(getattr(info, "alpha_in", None)),
        "alpha_out_pool": to_tao_exact(getattr(info, "alpha_out", None)),
        "subnet_volume_tao": to_tao_exact(getattr(info, "subnet_volume", None)),
        "owner_hotkey": str(getattr(info, "owner_hotkey", "") or "") or None,
        "owner_coldkey": str(getattr(info, "owner_coldkey", "") or "") or None,
        # --- v440 emission pipeline (#8743) -------------------------------
        # Every field here comes from normalize_pipeline, read from storage at
        # ONE pinned block -- see PIPELINE_STORAGE_ITEMS for why none of it is
        # taken off MetagraphInfo even where the bulk call carries it.
        **(pipeline or {}),
    }


def normalize_info(info, mechanism_count, identity=None, pipeline=None):
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
        "economics": normalize_economics(info, pipeline),
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
    # "finney" alias -- callers are refresh-native-snapshot.ts (production
    # publish + the indexer-box data-refresh-economics systemd timer) and
    # sync-subnets.yml via scripts/sync-subnets.ts's fetchNativeSnapshot().
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

    # Best-effort, and deliberately so: a node that cannot serve
    # state_queryStorageAt should cost the pipeline fields, not the whole
    # snapshot. Every consumer already treats a missing economics key as
    # null, so a degraded run publishes less rather than nothing.
    try:
        pipeline_state = fetch_pipeline_state(
            subtensor.substrate, sorted(by_netuid)
        )
    except Exception:
        pipeline_state = None

    subnets = [
        normalize_info(
            by_netuid[netuid],
            len(mechanisms.get(netuid, {0})),
            identities.get(netuid),
            normalize_pipeline(pipeline_state, netuid),
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

    # The height every pipeline read was pinned to, and the issuance that
    # block emission must be derived from (#8747 owns the derivation). Both
    # ride at the top level rather than per subnet: they are network-wide,
    # and a historical row is only interpretable against the block emission
    # in force when it was captured.
    if pipeline_state:
        gate = pipeline_state["gate_params"]
        payload["chain_state"] = {
            "block": pipeline_state["block"],
            "block_hash": pipeline_state["block_hash"],
            "total_issuance_tao": rao_to_tao_exact(
                pipeline_state["total_issuance_rao"]
            ),
            # theta and q are U64F64. h is NOT decoded to a fraction: it is a
            # small integer exponent, and null means "unset -> runtime default
            # 3", which is why it is not coerced to 0 here.
            "emission_gate_bar": (
                gate["emission_gate_bar"] / U64F64_SCALE
                if gate["emission_gate_bar"] is not None
                else None
            ),
            "emission_bar_quantile": (
                gate["emission_bar_quantile"] / U64F64_SCALE
                if gate["emission_bar_quantile"] is not None
                else None
            ),
            "emission_gate_exponent": gate["emission_gate_exponent"],
        }

    print(json.dumps(payload, indent=2, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
