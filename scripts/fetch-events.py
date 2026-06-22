#!/usr/bin/env python3
"""Chain-direct event poller (#1346, epic #1345) — FIRST-PARTY, not Taostats.

Decodes SubtensorModule events from a recent window of FINALIZED finney blocks
via substrate-interface against PUBLIC RPC (no API key), normalizes the
entity-relevant ones to `account_events` rows, and writes JSON to
dist/account-events.json. The refresh-events workflow stages that to R2; the
Worker's loadStagedEvents bulk-loads it into D1 with INSERT OR IGNORE keyed
(block_number, event_index) — idempotent, so an overlapping window re-inserts
harmlessly.

Durable high-water cursor (#1346 audit fix): the scan no longer starts at a
FIXED `head - window`. The refresh-events workflow reads the last successfully
staged block from R2 (events/cursor.json) and passes it as EVENTS_CURSOR; we
scan `compute_from_block(cursor, head, window) .. head`. So a long gap (GitHub's
scheduler coalescing/dropping runs for longer than the window) is recovered from
the cursor instead of silently lost, while EVENTS_WINDOW stays as a generous
overlap floor that keeps a cold/empty cursor safe and the load idempotent. After
a successful stage the workflow advances the cursor to `events-cursor.json`
(the max block scanned this run, written below).

Run:  uv run --with substrate-interface python scripts/fetch-events.py
Env:  EVENTS_RPC_URL        public finney WS endpoint (default below)
      EVENTS_WINDOW         overlap floor: min blocks back from the finalized
                            head, even with a fresh cursor (default 256)
      EVENTS_CURSOR         highest block already staged (from R2); blank/absent
                            on a cold start → fall back to the window floor
      ACCOUNT_EVENTS_JSON   events output path (default dist/account-events.json)
      EVENTS_CURSOR_OUT     next-cursor sidecar path (default dist/events-cursor.json)

Positional attribute order verified against live finney (2026-06-21); see
src/account-events.mjs INDEXED_EVENT_KINDS for the loaded set. Extractors are
defensive: a shape that doesn't match (e.g. after a runtime upgrade) yields a
skipped event, never a corrupt row.
"""
import json
import os
import sys

# NOTE: substrateinterface is imported lazily inside main() (not at module load).
# The pure cursor/window logic below (compute_from_block, _parse_cursor) carries
# the testable core, and stream-events.py imports this module only for `extract`;
# neither should require the heavy substrate dependency just to import the file.

RAO = 1e9
BLOCK_MS = 12000  # finney ~12s block time; observed_at derived from height
DEFAULT_RPC = "wss://entrypoint-finney.opentensor.ai:443"
WINDOW = int(os.environ.get("EVENTS_WINDOW", "256"))
OUT = os.environ.get("ACCOUNT_EVENTS_JSON", "dist/account-events.json")
CURSOR_OUT = os.environ.get("EVENTS_CURSOR_OUT", "dist/events-cursor.json")
# Public finney nodes prune ~300 blocks; if the cursor falls this far behind the
# head, the poller is losing the race against pruning and blocks between the prune
# horizon and the cursor can no longer be re-fetched. Surfaced as a workflow alert.
PRUNE_HORIZON = int(os.environ.get("EVENTS_PRUNE_HORIZON", "300"))


def _parse_cursor(raw):
    """Parse EVENTS_CURSOR (a bare integer block number) → int or None.

    Blank / absent / non-numeric / negative all mean "no usable cursor" (cold
    start) and yield None so compute_from_block falls back to the window floor.
    """
    if raw is None:
        return None
    s = str(raw).strip()
    if not s:
        return None
    try:
        n = int(s)
    except (TypeError, ValueError):
        return None
    return n if n >= 0 else None


def compute_from_block(cursor, head, window):
    """First block to scan this run — the testable core of the cursor logic.

    `from = max(cursor + 1, head - window + 1)`, clamped to >= 0. The window is an
    overlap FLOOR, the cursor a long-gap backstop:
      * cold cursor (None)                → head - window + 1  (the floor)
      * fresh cursor just behind head     → cursor + 1         (no needless rescan)
      * stale cursor older than the window→ still cursor + 1 if it's within the
        window of the head, else the floor — but we NEVER scan further back than
        the floor would require for a cold start beyond it; i.e. a wildly stale
        cursor is capped at the window so we don't try to re-scan the whole chain
        (blocks older than the prune horizon are gone anyway; the alert fires)
      * cursor >= head (reorg / clock skew) → head - window + 1 (the floor)

    Concretely: a cursor that is far behind head (gap > window) still resumes at
    cursor+1 ONLY while cursor+1 >= floor; once the gap exceeds the window the
    floor wins, bounding the scan to `window` blocks. That bound is the whole
    point — the cursor recovers gaps up to ~prune-horizon, the window caps the
    work, and pruned-out blocks are unrecoverable by design (alerted, not scanned).
    """
    floor = max(0, head - window + 1)
    if cursor is None:
        return floor
    if cursor >= head:
        # Cursor at/ahead of head: nothing new, or a reorg/skew rewound the head.
        # Re-scan the overlap window (idempotent) rather than an empty/negative range.
        return floor
    # cursor < head: resume just past it, but never further back than the floor
    # (caps a wildly stale cursor at `window` blocks instead of the whole chain).
    return max(cursor + 1, floor)


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


def _emit_lag_alert(head_bn, cursor):
    """If the cursor is within ~one window of the prune horizon, warn loudly.

    Writes a GitHub Actions `::warning::` (picked up in the run log/annotations)
    AND posts to METAGRAPH_ALERT_WEBHOOK_URL when configured, so a poller that is
    falling behind faster than it can catch up is VISIBLE before blocks are pruned
    out from under it — not silently lost. No-op on a cold cursor (nothing to lag).
    """
    if cursor is None:
        return
    lag = head_bn - cursor
    # Alert once the lag is within a window of the prune horizon (i.e. the next
    # missed/coalesced run could push un-fetched blocks past the prune point).
    if lag < PRUNE_HORIZON - WINDOW:
        return
    msg = (
        f"chain-event poller lagging: cursor={cursor} is {lag} blocks behind "
        f"finalized head {head_bn} (prune horizon ~{PRUNE_HORIZON}). Blocks risk "
        f"being pruned before they are fetched — increase cadence/window."
    )
    sys.stderr.write(f"::warning::{msg}\n")
    webhook = os.environ.get("METAGRAPH_ALERT_WEBHOOK_URL")
    if webhook:
        try:
            import urllib.request

            req = urllib.request.Request(
                webhook,
                data=json.dumps({"content": f"🟠 metagraphed {msg}"}).encode(),
                method="POST",
                headers={"content-type": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                resp.read()
        except Exception as e:  # never let alerting fail the poll
            sys.stderr.write(f"lag alert webhook failed: {repr(e)[:120]}\n")


def main():
    from substrateinterface import SubstrateInterface

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
    cursor = _parse_cursor(os.environ.get("EVENTS_CURSOR"))
    start = compute_from_block(cursor, head_bn, WINDOW)
    _emit_lag_alert(head_bn, cursor)

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

    # Next-cursor sidecar: the highest block we covered this run (the finalized
    # head we scanned through). The workflow stages the events first, then — only
    # on a successful stage — promotes this to events/cursor.json in R2 so the next
    # run resumes from here. The window floor still guarantees overlap, so even if
    # the staged batch is clobbered before the Worker drains it, recent blocks are
    # re-scanned next run (INSERT OR IGNORE makes the re-load harmless).
    next_cursor = max(head_bn, cursor) if cursor is not None else head_bn
    os.makedirs(os.path.dirname(CURSOR_OUT) or ".", exist_ok=True)
    with open(CURSOR_OUT, "w") as fh:
        json.dump({"block_number": next_cursor}, fh)

    sys.stderr.write(
        f"wrote {len(rows)} events from blocks {start}..{head_bn} "
        f"(cursor_in={cursor}, scanned {scanned}, skipped {skipped}) -> {OUT}; "
        f"next cursor {next_cursor} -> {CURSOR_OUT}\n"
    )


if __name__ == "__main__":
    main()
