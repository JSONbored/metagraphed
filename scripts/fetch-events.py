#!/usr/bin/env python3
"""Chain-direct event poller (#1346, epic #1345) — FIRST-PARTY, not Taostats.

Decodes SubtensorModule events from a recent window of FINALIZED finney blocks
via substrate-interface against PUBLIC RPC (no API key), normalizes the
entity-relevant ones to `account_events` rows, and writes JSON to
dist/account-events.json. The refresh-events workflow stages that to R2; the
Worker's loadStagedEvents bulk-loads it into D1 with INSERT OR IGNORE keyed
(block_number, event_index) — idempotent, so an overlapping window re-inserts
harmlessly.

Recent-window scan + cursor-driven gap recovery (ADR 0012): each run scans
`compute_from_block(cursor, head, window, max_lookback) .. head` — the overlap
window floor `head - EVENTS_WINDOW + 1` (always re-scanned; idempotent), extended
back to `cursor + 1` when the scheduler coalesced runs for longer than the window,
so the gap since the last staged block is recovered (bounded by
EVENTS_MAX_LOOKBACK). After a successful stage the workflow advances the cursor to
`events-cursor.json`.

SOURCE MATTERS — completeness depends on whether old blocks are still fetchable:
  - PUBLIC RPC (the $0 bootstrap): nodes prune state at ~300 blocks AND GitHub
    coalesces the */5 cron to ~1.5-4.5h, so gaps wider than the prune horizon are
    gone before a later run reaches them. EVENTS_MAX_LOOKBACK defaults to the prune
    horizon (no point scanning past it). This tier is best-effort and lossy by
    construction (measured: ~58% of the block range).
  - ARCHIVE node (ADR 0012 / #1349 — the durable target): retains every block, so
    pointing EVENTS_RPC_URL at it and raising EVENTS_MAX_LOOKBACK makes the cursor
    recovery COMPLETE — any coalescing gap is back-filled in full. The continuous
    indexer is the eventual low-latency end state.

Run:  uv run --with substrate-interface python scripts/fetch-events.py
Env:  EVENTS_RPC_URL        public finney WS endpoint (default below)
      EVENTS_WINDOW         overlap floor: min blocks back from the finalized
                            head, even with a fresh cursor (default 256)
      EVENTS_CURSOR         highest block already staged (from R2); blank/absent
                            on a cold start → fall back to the window floor
      ACCOUNT_EVENTS_JSON   events output path (default dist/account-events.json)
      EVENTS_CURSOR_OUT     next-cursor sidecar path (default dist/events-cursor.json)
      BLOCKS_JSON           per-block sidecar path (default dist/blocks.json) — the
                            block-explorer hot window (#1345), staged + loaded into
                            D1 `blocks` the same way the events JSON is
      EXTRINSICS_JSON       per-extrinsic sidecar path (default dist/extrinsics.json)
                            — the block-explorer extrinsic slice (#1345), staged +
                            loaded into D1 `extrinsics` the same way

Block-explorer sidecar (#1345 first vertical slice): the same per-block loop also
emits a `blocks` record (header hash, parent hash, best-effort author, extrinsic
count, decoded event count, observed_at) to BLOCKS_JSON. The refresh-events
workflow stages that sidecar to R2; the Worker's loadStagedBlocks bulk-loads it
into D1 `blocks` with INSERT OR IGNORE keyed on block_number — idempotent like the
events load. The extras are best-effort: a per-block extras failure skips that
block's block-row (never a corrupt row, never crashes the poll); the event rows
for that block are unaffected.

Block-explorer extrinsic sidecar (#1345 second vertical slice): the same per-block
loop also decodes each block's extrinsics (extrinsics_for_block) into `extrinsics`
rows (index, best-effort hash/signer, decoded call module+function, success from
the System.ExtrinsicSuccess/ExtrinsicFailed events for this index) and writes them
to EXTRINSICS_JSON. Staged + loaded into D1 `extrinsics` via loadStagedExtrinsics
with INSERT OR IGNORE keyed on (block_number, extrinsic_index) — idempotent. Each
extrinsic is best-effort: a per-extrinsic decode failure skips THAT row only
(never a corrupt row, never crashes the poll); the block/event rows are unaffected.

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
# Aura PreRuntime digest engine id == b"aura". Subtensor authors blocks with
# Aura (CONSENSUS_PALLETS = Aura, Grandpa), so the author is the slot's authority
# (Aura.Authorities[slot % n]). Verified against finney: consecutive blocks
# round-robin the 20-validator set.
AURA_ENGINE_ID = "0x61757261"
WINDOW = int(os.environ.get("EVENTS_WINDOW", "256"))
OUT = os.environ.get("ACCOUNT_EVENTS_JSON", "dist/account-events.json")
CURSOR_OUT = os.environ.get("EVENTS_CURSOR_OUT", "dist/events-cursor.json")
BLOCKS_OUT = os.environ.get("BLOCKS_JSON", "dist/blocks.json")
EXTRINSICS_OUT = os.environ.get("EXTRINSICS_JSON", "dist/extrinsics.json")
# Public finney nodes prune ~300 blocks; if the cursor falls this far behind the
# head, the poller is losing the race against pruning and blocks between the prune
# horizon and the cursor can no longer be re-fetched. Surfaced as a workflow alert.
PRUNE_HORIZON = int(os.environ.get("EVENTS_PRUNE_HORIZON", "300"))
# Upper bound on cursor-driven gap recovery: one run never scans more than this
# many blocks back from the head. Default = PRUNE_HORIZON — against PUBLIC RPC there
# is no point reaching past the prune wall (those blocks are gone). Against an
# ARCHIVE node (ADR 0012) set EVENTS_MAX_LOOKBACK high so a long scheduler gap is
# recovered in full; the archive still holds every block.
MAX_LOOKBACK = int(os.environ.get("EVENTS_MAX_LOOKBACK", str(PRUNE_HORIZON)))


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


def compute_from_block(cursor, head, window, max_lookback=PRUNE_HORIZON):
    """First block to scan this run — the testable core of the cursor logic.

    Returns the EARLIER of the overlap floor and `cursor + 1`, bounded below by the
    lookback limit:

      - **Overlap floor** `head - window + 1` is ALWAYS re-scanned. The workflow
        stages events to R2 and the Worker imports that pending object into D1
        asynchronously, so a promoted cursor only proves a range was staged, not
        durably loaded; re-scanning the overlap lets a later run recreate a recent
        staged batch if the single pending R2 object was overwritten before the
        Worker drained it (D1 inserts are idempotent, so the duplicate is harmless).
      - **`cursor + 1`** extends the scan back when the scheduler coalesced/dropped
        runs for longer than the window, so the GAP since the last staged block is
        recovered instead of silently lost. (Start never moves *ahead* of the
        overlap floor — `min` keeps the overlap re-scan intact.)
      - **`head - max_lookback`** bounds how far back one run reaches. Default is
        the prune horizon: against PUBLIC RPC there is no point scanning past the
        prune wall (those blocks are gone). Against an ARCHIVE node (ADR 0012) raise
        EVENTS_MAX_LOOKBACK so a long coalescing gap is recovered in full.

    Cold cursor (None) → just the overlap floor.
    """
    floor = max(0, head - window + 1)
    if cursor is None:
        return floor
    earliest = max(0, head - max_lookback)
    return max(earliest, min(floor, cursor + 1))


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


def _block_author(s, block_hash, header):
    """Block author (ss58) decoded from the Aura PreRuntime digest, else None.

    Subtensor authors blocks with Aura: the header's PreRuntime digest log
    (engine b"aura") carries the slot as a u64 LE; the author is
    Aura.Authorities[slot % n] at that block, ss58-encoded. Best-effort — returns
    None on any shape drift / missing data; NEVER raises (a perfect decode must
    never block the poll). Verified against finney (#1345).
    """
    try:
        if not isinstance(header, dict):
            return None
        logs = (header.get("digest") or {}).get("logs") or []
        slot = None
        for log in logs:
            v = log.value if hasattr(log, "value") else log
            pre = v.get("PreRuntime") if isinstance(v, dict) else None
            if not pre:
                continue
            engine, data = pre[0], pre[1]
            if engine == AURA_ENGINE_ID:
                hex_data = data[2:] if str(data).startswith("0x") else str(data)
                slot_data = bytes.fromhex(hex_data)
                if len(slot_data) != 8:
                    return None
                slot = int.from_bytes(slot_data, "little")
                break
        if slot is None:
            return None
        authorities = s.query("Aura", "Authorities", block_hash=block_hash).value or []
        if not authorities:
            return None
        pubkey = authorities[slot % len(authorities)]
        pk = pubkey[2:] if isinstance(pubkey, str) and pubkey.startswith("0x") else pubkey
        author = s.ss58_encode(pk)
        return author if isinstance(author, str) and author.startswith("5") else None
    except Exception:
        return None


def block_extras(s, bn, bh, event_count):
    """Best-effort per-block explorer record for the `blocks` D1 tier (#1345).

    One extra header read + one block read per block — fine for the bounded
    recent window. Wrapped so ANY failure (pruned/transient/shape drift) yields
    None: the caller skips that block's block-row, never corrupts it, and the
    event rows for the block are unaffected. observed_at is supplied by the
    caller (same height-derived timestamp the events use).
    """
    try:
        header = s.get_block_header(block_hash=bh)["header"]
    except Exception:
        return None
    parent_hash = header.get("parentHash") if isinstance(header, dict) else None
    try:
        extrinsic_count = len(s.get_block(block_hash=bh)["extrinsics"])
    except Exception:
        extrinsic_count = None
    return {
        "block_number": bn,
        "block_hash": str(bh),
        "parent_hash": str(parent_hash) if parent_hash is not None else None,
        "author": _block_author(s, bh, header),
        "extrinsic_count": extrinsic_count,
        "event_count": event_count,
    }


def _extrinsic_signer(value):
    """Best-effort ss58 signer from a decoded extrinsic's `address`, else None.

    Signed extrinsics carry an `address`; inherents/unsigned do not. Across
    runtimes the serialized address is usually a bare ss58 string but can be a
    MultiAddress dict (e.g. {"Id": "5…"}). Anything that doesn't resolve to a `5…`
    ss58 is left null — nullable signer is acceptable for v1 (#1345). NEVER raises.
    """
    try:
        addr = value.get("address") if isinstance(value, dict) else None
        if addr is None:
            return None
        if isinstance(addr, dict):
            addr = addr.get("Id") or addr.get("id")
        return addr if isinstance(addr, str) and addr.startswith("5") else None
    except Exception:
        return None


def _extrinsic_call(value):
    """Best-effort (call_module, call_function) from a decoded extrinsic, else
    (None, None). The serialized `call` carries string names; null on shape drift.
    NEVER raises."""
    try:
        call = value.get("call") if isinstance(value, dict) else None
        if not isinstance(call, dict):
            return (None, None)
        cm = call.get("call_module")
        cf = call.get("call_function")
        return (
            cm if isinstance(cm, str) else None,
            cf if isinstance(cf, str) else None,
        )
    except Exception:
        return (None, None)


def _extrinsic_success_map(events):
    """Map extrinsic_index -> success(1/0) from the block's already-decoded events.

    Substrate emits a System.ExtrinsicSuccess or System.ExtrinsicFailed event for
    each applied extrinsic, with phase `ApplyExtrinsic` and a top-level
    `extrinsic_idx` pointing at the extrinsic's position. We build the correlation
    from the SAME `events` the caller already decoded — no extra RPC. Best-effort:
    any malformed event is skipped; an index missing here yields null success.
    NEVER raises.
    """
    out = {}
    try:
        for ev in events:
            v = ev.value if isinstance(ev.value, dict) else {}
            if v.get("phase") != "ApplyExtrinsic":
                continue
            e = v.get("event", {}) if isinstance(v.get("event"), dict) else {}
            if e.get("module_id") != "System":
                continue
            eid = e.get("event_id")
            if eid not in ("ExtrinsicSuccess", "ExtrinsicFailed"):
                continue
            idx = v.get("extrinsic_idx")
            if isinstance(idx, int) and idx >= 0:
                out[idx] = 1 if eid == "ExtrinsicSuccess" else 0
    except Exception:
        return out
    return out


def extrinsics_for_block(s, bn, bh, events):
    """Best-effort per-extrinsic records for the `extrinsics` D1 tier (#1345).

    Decodes the block's extrinsics (one block read, reusing the same handler that
    block_extras counts) and correlates each with the success/failure events the
    caller already decoded. Returns a list of rows; ANY per-extrinsic failure
    skips THAT row only (never a corrupt row, never crashes the poll). A total
    block-read failure (pruned/transient/shape drift) returns [] so the caller
    simply emits no extrinsic rows for this block — its block/event rows are
    unaffected. observed_at is added by the caller (same height-derived clock).
    NEVER raises.
    """
    rows = []
    try:
        block = s.get_block(block_hash=bh)
        extrinsics = block.get("extrinsics") if isinstance(block, dict) else None
        if not isinstance(extrinsics, list):
            return rows
    except Exception:
        return rows
    success_map = _extrinsic_success_map(events)
    for extrinsic_index, ext in enumerate(extrinsics):
        try:
            value = ext.value if ext is not None else None
            if not isinstance(value, dict):
                continue  # an undecodable extrinsic — skip this row only
            xhash = value.get("extrinsic_hash")
            call_module, call_function = _extrinsic_call(value)
            rows.append(
                {
                    "block_number": bn,
                    "extrinsic_index": extrinsic_index,
                    "extrinsic_hash": str(xhash) if xhash is not None else None,
                    "signer": _extrinsic_signer(value),
                    "call_module": call_module,
                    "call_function": call_function,
                    "success": success_map.get(extrinsic_index),
                }
            )
        except Exception:
            continue  # shape drift on one extrinsic → skip it, keep the rest
    return rows


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
    start = compute_from_block(cursor, head_bn, WINDOW, MAX_LOOKBACK)
    _emit_lag_alert(head_bn, cursor)

    rows = []
    blocks = []
    extrinsics = []
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
        # Block-explorer hot-window record (#1345): best-effort header extras +
        # the decoded event count, observed_at from the same height-derived clock
        # as the events. A None means the extras read failed — skip this block's
        # block-row only (its event rows below are unaffected).
        extras = block_extras(s, bn, bh, len(events))
        if extras is not None:
            extras["observed_at"] = observed_at
            blocks.append(extras)
        # Block-explorer extrinsic records (#1345 second slice): decode each
        # extrinsic with its decoded call + success/failure correlation. Each row
        # carries the same height-derived observed_at; a per-extrinsic failure is
        # skipped inside extrinsics_for_block (never corrupts/crashes).
        for xrow in extrinsics_for_block(s, bn, bh, events):
            xrow["observed_at"] = observed_at
            extrinsics.append(xrow)
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

    # Block-explorer sidecar (#1345): the recent-window block rows. Staged to R2
    # + loaded into D1 `blocks` by the Worker (loadStagedBlocks) just like the
    # events JSON. A bare array — the same signer/loader envelope shape applies.
    os.makedirs(os.path.dirname(BLOCKS_OUT) or ".", exist_ok=True)
    with open(BLOCKS_OUT, "w") as fh:
        json.dump(blocks, fh)

    # Block-explorer extrinsic sidecar (#1345 second slice): the recent-window
    # extrinsic rows. Staged to R2 + loaded into D1 `extrinsics` by the Worker
    # (loadStagedExtrinsics) just like the events/blocks JSON. A bare array — the
    # same signer/loader envelope shape applies.
    os.makedirs(os.path.dirname(EXTRINSICS_OUT) or ".", exist_ok=True)
    with open(EXTRINSICS_OUT, "w") as fh:
        json.dump(extrinsics, fh)

    # Next-cursor sidecar: the highest block we covered this run (the finalized
    # head we scanned through). The workflow stages the events first, then — only
    # on a successful stage — promotes this to events/cursor.json in R2. Because
    # staging and D1 loading are asynchronous, compute_from_block still re-scans
    # the overlap window every run; the cursor is retained for lag/health alerts,
    # not as proof that staged rows have already been imported into D1.
    next_cursor = max(head_bn, cursor) if cursor is not None else head_bn
    os.makedirs(os.path.dirname(CURSOR_OUT) or ".", exist_ok=True)
    with open(CURSOR_OUT, "w") as fh:
        json.dump({"block_number": next_cursor}, fh)

    sys.stderr.write(
        f"wrote {len(rows)} events from blocks {start}..{head_bn} "
        f"(cursor_in={cursor}, scanned {scanned}, skipped {skipped}) -> {OUT}; "
        f"wrote {len(blocks)} block rows -> {BLOCKS_OUT}; "
        f"wrote {len(extrinsics)} extrinsic rows -> {EXTRINSICS_OUT}; "
        f"next cursor {next_cursor} -> {CURSOR_OUT}\n"
    )


if __name__ == "__main__":
    main()
