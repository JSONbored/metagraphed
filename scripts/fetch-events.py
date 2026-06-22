#!/usr/bin/env python3
"""Chain-direct event poller (#1346, epic #1345) — FIRST-PARTY, not Taostats.

Decodes SubtensorModule events from a rolling window of recent FINALIZED finney
blocks via substrate-interface against PUBLIC RPC (no API key), normalizes the
entity-relevant ones to `account_events` rows, and writes JSON to
dist/account-events.json. The refresh-events workflow stages that to R2; the
Worker's loadStagedEvents bulk-loads it into D1 with INSERT OR IGNORE keyed
(block_number, event_index) — idempotent, so overlapping windows need no cursor.

Run:  uv run --with substrate-interface python scripts/fetch-events.py
Env:  EVENTS_RPC_URL        public finney WS endpoint (default below)
      EVENTS_WINDOW         blocks back from the finalized head (default 256)
      ACCOUNT_EVENTS_JSON   output path (default dist/account-events.json)

Positional attribute order verified against live finney (2026-06-21); see
src/account-events.mjs INDEXED_EVENT_KINDS for the loaded set. Extractors are
defensive: a shape that doesn't match (e.g. after a runtime upgrade) yields a
skipped event, never a corrupt row.
"""
import json
import os
import sys

from substrateinterface import SubstrateInterface

RAO = 1e9
BLOCK_MS = 12000  # finney ~12s block time; observed_at derived from height
DEFAULT_RPC = "wss://entrypoint-finney.opentensor.ai:443"
WINDOW = int(os.environ.get("EVENTS_WINDOW", "256"))
OUT = os.environ.get("ACCOUNT_EVENTS_JSON", "dist/account-events.json")


def _ss58(v):
    return v if isinstance(v, str) and v.startswith("5") else None


def _idx(v):
    return v if isinstance(v, int) and 0 <= v <= 65535 else None


def _tao(v):
    return (v / RAO) if isinstance(v, (int, float)) and v >= 0 else None


# Each extractor maps a decoded attribute tuple -> the entity fields we store.
def _stake(a):  # [coldkey, hotkey, tao_rao, alpha_rao, netuid, ...]
    return {
        "coldkey": _ss58(a[0]),
        "hotkey": _ss58(a[1]),
        "amount_tao": _tao(a[2]),
        "netuid": _idx(a[4]) if len(a) > 4 else None,
    }


def _registered(a):  # [netuid, uid, hotkey]
    return {"netuid": _idx(a[0]), "uid": _idx(a[1]), "hotkey": _ss58(a[2])}


def _axon(a):  # [netuid, hotkey]
    return {"netuid": _idx(a[0]), "hotkey": _ss58(a[1])}


def _weights(a):  # [netuid, uid]  (no hotkey; resolvable via the neurons table)
    return {"netuid": _idx(a[0]), "uid": _idx(a[1])}


def _moved(a):  # [coldkey, hotkey, netuid, ...]
    return {
        "coldkey": _ss58(a[0]),
        "hotkey": _ss58(a[1]),
        "netuid": _idx(a[2]) if len(a) > 2 else None,
    }


def _root(a):  # {coldkey} (named) or [coldkey]
    ck = a.get("coldkey") if isinstance(a, dict) else (a[0] if a else None)
    return {"coldkey": _ss58(ck)}


EXTRACTORS = {
    "NeuronRegistered": _registered,
    "StakeAdded": _stake,
    "StakeRemoved": _stake,
    "StakeMoved": _moved,
    "AxonServed": _axon,
    "WeightsSet": _weights,
    "RootClaimed": _root,
}


def extract(event_id, attrs):
    fn = EXTRACTORS.get(event_id)
    if not fn:
        return None
    try:
        f = fn(attrs)
    except Exception:
        return None  # shape drift → skip, never corrupt
    return {
        "hotkey": f.get("hotkey"),
        "coldkey": f.get("coldkey"),
        "netuid": f.get("netuid"),
        "uid": f.get("uid"),
        "amount_tao": f.get("amount_tao"),
    }


def main():
    url = os.environ.get("EVENTS_RPC_URL", DEFAULT_RPC)
    s = SubstrateInterface(url=url)
    head = s.get_chain_finalised_head()
    head_bn = s.get_block_header(block_hash=head)["header"]["number"]
    try:
        head_ts = int(s.query("Timestamp", "Now", block_hash=head).value)
    except Exception as e:
        raise RuntimeError(
            "finalized head timestamp is required for account_events"
        ) from e
    start = max(0, head_bn - WINDOW + 1)

    rows = []
    scanned = 0
    skipped = 0
    for bn in range(start, head_bn + 1):
        observed_at = head_ts - (head_bn - bn) * BLOCK_MS
        try:
            bh = s.get_block_hash(bn)
            events = s.query("System", "Events", block_hash=bh)
        except Exception as e:  # pruned/transient → skip this block, keep going
            skipped += 1
            sys.stderr.write(f"block {bn}: skip ({repr(e)[:80]})\n")
            continue
        scanned += 1
        for event_index, ev in enumerate(events):
            v = ev.value if isinstance(ev.value, dict) else {}
            e = v.get("event", {}) if isinstance(v.get("event"), dict) else {}
            if e.get("module_id") != "SubtensorModule":
                continue
            eid = e.get("event_id")
            ent = extract(eid, e.get("attributes"))
            if ent is None:
                continue
            rows.append(
                {
                    "block_number": bn,
                    "event_index": event_index,
                    "event_kind": eid,
                    "hotkey": ent["hotkey"],
                    "coldkey": ent["coldkey"],
                    "netuid": ent["netuid"],
                    "uid": ent["uid"],
                    "amount_tao": ent["amount_tao"],
                    "observed_at": observed_at,
                }
            )

    os.makedirs(os.path.dirname(OUT) or ".", exist_ok=True)
    with open(OUT, "w") as fh:
        json.dump(rows, fh)
    sys.stderr.write(
        f"wrote {len(rows)} events from blocks {start}..{head_bn} "
        f"(scanned {scanned}, skipped {skipped}) -> {OUT}\n"
    )


if __name__ == "__main__":
    main()
