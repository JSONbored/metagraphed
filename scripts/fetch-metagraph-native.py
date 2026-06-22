#!/usr/bin/env python3
"""First-party per-UID metagraph fetcher (#1348) — chain-direct, REPLACING the
Taostats fetch (scripts/fetch-metagraph.mjs). One `get_all_metagraphs_info` call
yields most per-UID fields for every subnet; `rank` + `validator_trust` come from
SubtensorModule storage (MetagraphInfo doesn't carry them in dTAO). Emits the exact
`NEURON_INSERT_COLUMNS` shape to dist/metagraph-neurons.json — a drop-in for the
Worker's token-free `loadStagedNeurons`. No Taostats, no API key.

Units (verified by the parity check vs the prior Taostats data, #1348):
  stake_tao/emission_tao = float(Balance, alpha-denominated)
  consensus/incentive/dividends = on-chain 0..1 floats
  rank/validator_trust = SubtensorModule u16 (0..65535) ÷ 65535
  trust = 0.0 (dead in dTAO — 0 across all neurons, Taostats included)

Run: uv run --with bittensor python scripts/fetch-metagraph-native.py
"""
import argparse
import ipaddress
import json
import os
import sys
import time

import bittensor as bt

OUT = os.environ.get("METAGRAPH_NEURONS_JSON", "dist/metagraph-neurons.json")


def to_float(value):
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def u16_ratio(value):
    """SubtensorModule Rank/ValidatorTrust are u16 (0..65535) → 0..1 ratio."""
    try:
        n = int(value)
    except (TypeError, ValueError):
        return None
    return round(n / 65535, 9)


def fmt_axon(axon):
    """axons[uid] = {ip:int, port:int, ...}; ip 0 → not serving."""
    if not isinstance(axon, dict):
        return None
    ip = axon.get("ip") or 0
    port = axon.get("port") or 0
    if not ip:
        return None
    try:
        host = str(ipaddress.ip_address(int(ip)))
    except (ValueError, TypeError):
        return None
    return f"{host}:{port}" if port else host


def _at(arr, i):
    return arr[i] if i < len(arr) else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--network", default="finney")
    args = parser.parse_args()

    s = bt.SubtensorApi(network=args.network)
    infos = s.metagraphs.get_all_metagraphs_info(all_mechanisms=True)

    # Dedupe by netuid (mechid 0 is canonical), matching fetch-native-subnets.py.
    by_netuid = {}
    for info in infos:
        nu = int(info.netuid)
        mechid = int(getattr(info, "mechid", 0) or 0)
        if mechid == 0 or nu not in by_netuid:
            by_netuid[nu] = info

    def storage_vec(netuid, name):
        try:
            r = s.substrate.query("SubtensorModule", name, [netuid])
            return list(getattr(r, "value", r) or [])
        except Exception:
            return []

    captured_at = int(time.time() * 1000)
    rows = []
    for netuid in sorted(by_netuid):
        info = by_netuid[netuid]
        hotkeys = list(getattr(info, "hotkeys", []) or [])
        n = len(hotkeys)
        if not n:
            continue
        coldkeys = list(getattr(info, "coldkeys", []) or [])
        active = list(getattr(info, "active", []) or [])
        permits = list(getattr(info, "validator_permit", []) or [])
        consensus = list(getattr(info, "consensus", []) or [])
        incentives = list(getattr(info, "incentives", []) or [])
        dividends = list(getattr(info, "dividends", []) or [])
        emission = list(getattr(info, "emission", []) or [])
        stake = list(getattr(info, "total_stake", []) or [])
        axons = list(getattr(info, "axons", []) or [])
        reg_at = list(getattr(info, "block_at_registration", []) or [])
        block = int(getattr(info, "block", 0) or 0)
        immunity = int(getattr(info, "immunity_period", 0) or 0)
        vtrust_vec = storage_vec(netuid, "ValidatorTrust")
        subnet_rows = []
        for uid in range(n):
            reg = _at(reg_at, uid)
            subnet_rows.append(
                {
                    "netuid": netuid,
                    "uid": uid,
                    "hotkey": _at(hotkeys, uid),
                    "coldkey": _at(coldkeys, uid),
                    "active": 1 if _at(active, uid) else 0,
                    "validator_permit": 1 if _at(permits, uid) else 0,
                    "rank": None,  # derived below (no chain rank-position storage)
                    "trust": 0.0,
                    "validator_trust": u16_ratio(_at(vtrust_vec, uid)),
                    "consensus": to_float(_at(consensus, uid)),
                    "incentive": to_float(_at(incentives, uid)),
                    "dividends": to_float(_at(dividends, uid)),
                    "emission_tao": to_float(_at(emission, uid)),
                    "stake_tao": to_float(_at(stake, uid)),
                    "registered_at_block": reg,
                    "is_immunity_period": 1
                    if (reg is not None and block - reg < immunity)
                    else 0,
                    "axon": fmt_axon(_at(axons, uid)),
                    "block_number": block,
                    "captured_at": captured_at,
                }
            )
        # SubtensorModule has no rank-position storage in dTAO; derive the
        # Taostats-style ranking — 1-based position by incentive desc (null for
        # non-incentivized neurons; consumers can also sort by incentive directly).
        for pos, row in enumerate(
            sorted(
                (r for r in subnet_rows if r["incentive"]),
                key=lambda r: (-r["incentive"], r["uid"]),
            ),
            start=1,
        ):
            row["rank"] = float(pos)
        rows.extend(subnet_rows)

    valid = [r for r in rows if r["hotkey"]]
    os.makedirs(os.path.dirname(OUT) or ".", exist_ok=True)
    with open(OUT, "w") as fh:
        json.dump(valid, fh)
    sys.stderr.write(
        f"wrote {len(valid)} neurons across {len(by_netuid)} subnets -> {OUT}\n"
    )


if __name__ == "__main__":
    main()
