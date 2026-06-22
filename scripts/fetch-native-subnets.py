#!/usr/bin/env python3
"""Fetch decoded Bittensor Finney subnet metadata + optional per-UID neurons (#1348).

Default stdout: subnet registry snapshot for sync-subnets.mjs.
With --neurons-out: emit per-UID neuron rows (same D1 shape as loadStagedNeurons).
With --neurons-only: skip identity RPC + subnet stdout (refresh-metagraph path).
With --self-test: offline normalization checks (no chain RPC).
"""
import argparse
import json
import os
import sys
from datetime import datetime, timezone


def to_tao(value):
    """Coerce a bittensor Balance (or plain number) to a float.

    Balance.__float__ already returns the tao-denominated value; plain ints and
    floats pass through. Anything else (None, unexpected type) becomes None so a
    single odd field never aborts the per-subnet economics block.
    """
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


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
    stakes = [
        stake
        for stake in (
            to_tao(entry) for entry in (getattr(info, "total_stake", []) or [])
        )
        if stake is not None
    ]
    return {
        "max_uids": int(getattr(info, "max_uids", 0) or 0),
        "validator_count": validator_count,
        "max_validators": int(getattr(info, "max_validators", 0) or 0),
        "miner_count": max(0, num_uids - validator_count),
        "registration_allowed": bool(getattr(info, "registration_allowed", False)),
        "registration_cost_tao": to_tao(getattr(info, "burn", None)),
        # dTAO emission is price-weighted: a subnet's share of network TAO
        # emission tracks its alpha price (moving_price), not the now-zeroed
        # subnet_emission/tao_in_emission fields. We capture the price here and
        # derive each subnet's emission_share at build time (price / Σ price).
        "alpha_price_tao": to_tao(getattr(info, "moving_price", None)),
        "total_stake_tao": round(sum(stakes), 9) if stakes else None,
        "max_stake_tao": round(max(stakes), 9) if stakes else None,
        "tao_in_pool_tao": to_tao(getattr(info, "tao_in", None)),
        "alpha_in_pool": to_tao(getattr(info, "alpha_in", None)),
        "alpha_out_pool": to_tao(getattr(info, "alpha_out", None)),
        "subnet_volume_tao": to_tao(getattr(info, "subnet_volume", None)),
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


MAX_UIDS_PER_SUBNET = 4096
PER_UID_ARRAY_FIELDS = (
    "hotkeys",
    "coldkeys",
    "active",
    "validator_permit",
    "rank",
    "trust",
    "consensus",
    "incentives",
    "dividends",
    "emission",
    "total_stake",
    "block_at_registration",
    "axons",
)


def _as_list(value):
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        return list(value)
    return []


def _sanitize_ss58(value):
    if not isinstance(value, str):
        return None
    candidate = value.strip()
    if not candidate.startswith("5") or len(candidate) < 40:
        return None
    return candidate


def _safe_int(value, default=None):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def validate_info_for_neurons(netuid, info):
    """Return (ok, reason). Skip subnets with malformed MetagraphInfo arrays."""
    num_uids = _safe_int(getattr(info, "num_uids", None), -1)
    if num_uids is None or num_uids < 0:
        return False, "invalid num_uids"
    if num_uids > MAX_UIDS_PER_SUBNET:
        return False, f"num_uids out of range ({num_uids})"
    if num_uids == 0:
        return True, None
    for field in PER_UID_ARRAY_FIELDS:
        arr = _as_list(getattr(info, field, None))
        if arr and len(arr) < num_uids:
            return False, f"{field} shorter than num_uids ({len(arr)} < {num_uids})"
    return True, None


def _at(values, uid):
    arr = _as_list(values)
    if uid < 0 or uid >= len(arr):
        return None
    return arr[uid]


def _bool_int(value):
    return 1 if value else 0


def _ratio(value):
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number >= 0 else None


def format_axon(axon):
    if not axon or isinstance(axon, (str, int, float, bool)):
        return None
    ip = getattr(axon, "ip", None) or ""
    if not isinstance(ip, str):
        ip = str(ip)
    if not ip or ip == "0.0.0.0":
        return None
    port = getattr(axon, "port", None)
    try:
        port = int(port) if port is not None else None
    except (TypeError, ValueError):
        port = None
    if port and port > 0:
        return f"{ip}:{port}"
    return ip


def normalize_neuron(netuid, uid, info, captured_at_ms):
    """Map one MetagraphInfo UID slot to the D1 `neurons` row shape (#1303/#1348).

    Per-UID arrays come from get_all_metagraphs_info — same source as economics
    aggregation. validator_trust is not exposed on MetagraphInfo (null). Units:
      stake_tao / emission_tao = Balance -> TAO float (Σ stake matches economics)
      trust/consensus/incentive/dividends/rank = SDK u16-normalized 0..1 ratios
    """
    block = _safe_int(getattr(info, "block", 0), 0) or 0
    immunity_period = _safe_int(getattr(info, "immunity_period", 0), 0) or 0
    registered_at_block = _safe_int(
        _at(getattr(info, "block_at_registration", None), uid)
    )
    is_immunity_period = bool(
        registered_at_block is not None
        and immunity_period > 0
        and block - registered_at_block < immunity_period
    )
    stake = to_tao(_at(getattr(info, "total_stake", None), uid))
    if stake is not None:
        stake = round(stake, 9)
    return {
        "netuid": int(netuid),
        "uid": int(uid),
        "hotkey": _sanitize_ss58(_at(getattr(info, "hotkeys", None), uid)),
        "coldkey": _sanitize_ss58(_at(getattr(info, "coldkeys", None), uid)),
        "active": _bool_int(_at(getattr(info, "active", None), uid)),
        "validator_permit": _bool_int(
            _at(getattr(info, "validator_permit", None), uid)
        ),
        "rank": _ratio(_at(getattr(info, "rank", None), uid)),
        "trust": _ratio(_at(getattr(info, "trust", None), uid)),
        "validator_trust": None,
        "consensus": _ratio(_at(getattr(info, "consensus", None), uid)),
        "incentive": _ratio(_at(getattr(info, "incentives", None), uid)),
        "dividends": _ratio(_at(getattr(info, "dividends", None), uid)),
        "emission_tao": to_tao(_at(getattr(info, "emission", None), uid)),
        "stake_tao": stake,
        "registered_at_block": registered_at_block,
        "is_immunity_period": _bool_int(is_immunity_period),
        "axon": format_axon(_at(getattr(info, "axons", None), uid)),
        "block_number": block,
        "captured_at": captured_at_ms,
    }


def emit_neurons(by_netuid, captured_at_ms):
    rows = []
    skipped = 0
    for netuid in sorted(by_netuid):
        info = by_netuid[netuid]
        ok, reason = validate_info_for_neurons(netuid, info)
        if not ok:
            skipped += 1
            print(
                f"netuid {netuid}: skip neurons ({reason})",
                file=sys.stderr,
            )
            continue
        num_uids = _safe_int(getattr(info, "num_uids", 0), 0) or 0
        for uid in range(num_uids):
            rows.append(normalize_neuron(netuid, uid, info, captured_at_ms))
    return rows, skipped


def verify_neuron_economics(by_netuid, rows):
    """Best-effort Σ stake + validator_count cross-check vs economics (#1348)."""
    warnings = 0
    for netuid, info in by_netuid.items():
        subnet_rows = [row for row in rows if row["netuid"] == netuid]
        econ = normalize_economics(info)
        stake_sum = round(
            sum(row["stake_tao"] or 0 for row in subnet_rows),
            9,
        )
        expected_stake = econ.get("total_stake_tao")
        if (
            expected_stake is not None
            and subnet_rows
            and abs(stake_sum - expected_stake) > 0.01
        ):
            warnings += 1
            print(
                f"netuid {netuid}: stake sum {stake_sum} != economics {expected_stake}",
                file=sys.stderr,
            )
        validator_count = sum(row["validator_permit"] for row in subnet_rows)
        expected_validators = econ.get("validator_count")
        if (
            expected_validators is not None
            and validator_count != expected_validators
        ):
            warnings += 1
            print(
                f"netuid {netuid}: validator_count {validator_count} != economics {expected_validators}",
                file=sys.stderr,
            )
    return warnings


def write_neurons_json(path, rows):
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(rows, handle)


def select_primary_infos(infos):
    by_netuid = {}
    mechanisms = {}
    for info in infos or []:
        netuid = _safe_int(getattr(info, "netuid", None))
        if netuid is None:
            print("skip metagraph info with invalid netuid", file=sys.stderr)
            continue
        mechid = _safe_int(getattr(info, "mechid", 0), 0) or 0
        mechanisms.setdefault(netuid, set()).add(mechid)
        if mechid == 0 or netuid not in by_netuid:
            by_netuid[netuid] = info
    return by_netuid, mechanisms


def finalize_neuron_fetch(by_netuid, rows, skipped, *, strict=False):
    if not by_netuid:
        print("aborting: no subnets returned by SDK", file=sys.stderr)
        sys.exit(1)
    if not rows:
        print("aborting: zero neuron rows emitted", file=sys.stderr)
        sys.exit(1)
    subnet_total = len(by_netuid)
    if skipped > subnet_total / 2:
        print(
            f"aborting: {skipped}/{subnet_total} subnets skipped due to malformed arrays",
            file=sys.stderr,
        )
        sys.exit(1)
    warnings = verify_neuron_economics(by_netuid, rows)
    if strict and warnings:
        print(
            f"aborting: {warnings} subnet(s) failed economics cross-check",
            file=sys.stderr,
        )
        sys.exit(1)
    return warnings


def run_self_test():
    class MockAxon:
        ip = "1.2.3.4"
        port = 8091

    class MockBalance:
        def __init__(self, tao):
            self._tao = tao

        def __float__(self):
            return self._tao

    class MockInfo:
        block = 8454388
        num_uids = 253
        immunity_period = 7200
        hotkeys = ["5HbNZ77cXQXbUjXG3YLVBGk6N4WbtKtGQYAWLXd2aWa8fqGe"] * 253
        coldkeys = ["5FRXwb2qsEhqDQQKcm5m2MF26xTWwW65MHTEtKFFydypuqjG"] * 253
        active = [False] * 252 + [True]
        validator_permit = [False] * 252 + [True]
        rank = [0.0] * 252 + [1.0]
        trust = [0.0] * 253
        consensus = [0.0] * 253
        incentives = [0.0] * 253
        dividends = [0.0] * 252 + [0.53974212252994583047]
        emission = [MockBalance(0.0)] * 252 + [MockBalance(22.129845598)]
        total_stake = [MockBalance(0.0)] * 252 + [MockBalance(1344255.529357282)]
        block_at_registration = [6702485] * 253
        axons = [None] * 252 + [MockAxon()]

    row = normalize_neuron(1, 252, MockInfo(), 1000)
    assert row["stake_tao"] == 1344255.529357282
    assert row["emission_tao"] == 22.129845598
    assert row["validator_permit"] == 1
    assert row["active"] == 1
    assert row["axon"] == "1.2.3.4:8091"
    assert row["registered_at_block"] == 6702485
    assert row["is_immunity_period"] == 0
    assert row["validator_trust"] is None
    assert row["dividends"] == 0.53974212252994583047

    by_netuid = {1: MockInfo()}
    rows, skipped = emit_neurons(by_netuid, 1000)
    assert len(rows) == 253
    assert skipped == 0
    assert verify_neuron_economics(by_netuid, rows) == 0

    class ShortHotkeysInfo(MockInfo):
        hotkeys = ["5HbNZ77cXQXbUjXG3YLVBGk6N4WbtKtGQYAWLXd2aWa8fqGe"]

    short_rows, short_skipped = emit_neurons({2: ShortHotkeysInfo()}, 1000)
    assert short_rows == []
    assert short_skipped == 1

    bad_row = normalize_neuron(3, 0, MockInfo(), 1000)
    assert bad_row["hotkey"] is not None
    bad_info = MockInfo()
    bad_info.hotkeys = [123, None]
    assert normalize_neuron(3, 0, bad_info, 1000)["hotkey"] is None
    assert format_axon("not-an-axon") is None

    print("fetch-native-subnets self-test ok", file=sys.stderr)


def main():
    import bittensor as bt

    parser = argparse.ArgumentParser(description="Fetch decoded Bittensor Finney subnet metadata.")
    parser.add_argument("--network", default="finney")
    parser.add_argument(
        "--neurons-out",
        help="Write per-UID neuron rows JSON (D1/loadStagedNeurons shape) to this path",
    )
    parser.add_argument(
        "--neurons-only",
        action="store_true",
        help="Only fetch neurons (skip subnet stdout + identity RPC)",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Exit non-zero when validation/economics checks fail (CI path)",
    )
    args = parser.parse_args()

    if args.neurons_only and not args.neurons_out:
        parser.error("--neurons-only requires --neurons-out")

    try:
        subtensor = bt.SubtensorApi(network=args.network)
        infos = subtensor.metagraphs.get_all_metagraphs_info(all_mechanisms=True)
    except Exception as exc:
        print(f"SDK fetch failed: {exc}", file=sys.stderr)
        sys.exit(1)

    by_netuid, mechanisms = select_primary_infos(infos)
    captured_at_ms = int(datetime.now(timezone.utc).timestamp() * 1000)

    if args.neurons_out:
        rows, skipped = emit_neurons(by_netuid, captured_at_ms)
        warnings = finalize_neuron_fetch(
            by_netuid,
            rows,
            skipped,
            strict=args.strict,
        )
        write_neurons_json(args.neurons_out, rows)
        print(
            f"wrote {len(rows)} neurons across {len(by_netuid) - skipped}/{len(by_netuid)} subnets -> {args.neurons_out}",
            file=sys.stderr,
        )
        if warnings:
            print(
                f"warning: {warnings} subnet(s) failed economics cross-check",
                file=sys.stderr,
            )
        if args.neurons_only:
            return

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
    if "--self-test" in sys.argv:
        run_self_test()
    else:
        main()
