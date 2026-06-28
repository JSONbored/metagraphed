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
      EVENTS_BATCH_BLOCKS   max blocks emitted in one staged batch (default EVENTS_WINDOW)
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
# Producer-side batch guard for cursor recovery. The Worker drains one pending R2
# object at a time, with byte/row caps; keep each recovery poll bounded so archive
# mode advances through long gaps over multiple safe staged batches instead of
# producing one pathological object.
BATCH_BLOCKS = max(1, int(os.environ.get("EVENTS_BATCH_BLOCKS", str(WINDOW))))
# Keep producer batches below the Worker staged-event row cap (10k) and,
# indirectly, below its 4 MiB parse-safety byte cap even when high-volume
# Balances.Transfer events are present. Reserve headroom for the HMAC envelope.
MAX_EVENT_ROWS = max(1, int(os.environ.get("EVENTS_MAX_EVENT_ROWS", "9000")))


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


def compute_scan_range(cursor, head, window, max_lookback=PRUNE_HORIZON, batch_blocks=None):
    """Inclusive block range to scan for one staged producer batch.

    The start preserves cursor-driven gap recovery. The end is capped by
    `batch_blocks` (default: `window`) so a long archive-node recovery is emitted
    as several bounded staged batches. This keeps each pending R2 object inside the
    Worker's progressive-drain envelope and lets the workflow promote only the
    highest block actually staged in this run.
    """
    start = compute_from_block(cursor, head, window, max_lookback)
    limit = window if batch_blocks is None else max(1, int(batch_blocks))
    end = min(head, start + limit - 1)
    return start, end


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
        # The alpha leg of the swap (#1856): how much subnet alpha the TAO bought
        # (StakeAdded) or sold (StakeRemoved). Null on shape drift / other kinds.
        "alpha_amount": _tao(a[3]) if len(a) > 3 else None,
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


def _transfer(a):  # Balances.Transfer: [from, to, amount] or {from, to, amount}
    if isinstance(a, dict):
        sender, recipient, amount = a.get("from"), a.get("to"), a.get("amount")
    else:
        sender = a[0] if len(a) > 0 else None
        recipient = a[1] if len(a) > 1 else None
        amount = a[2] if len(a) > 2 else None
    # hotkey = sender, coldkey = recipient (pragmatic reuse of the index columns)
    return {"hotkey": _ss58(sender), "coldkey": _ss58(recipient), "amount_tao": _tao(amount)}


def _net(a):  # NetworkAdded/NetworkRemoved: {netuid, ...} or [netuid, ...]
    netuid = a.get("netuid") if isinstance(a, dict) else (a[0] if len(a) > 0 else None)
    return {"netuid": _idx(netuid)}


def _delegate_added(a):  # DelegateAdded: {coldkey, hotkey, take} or [coldkey, hotkey, ...]
    if isinstance(a, dict):
        ck, hk = a.get("coldkey"), a.get("hotkey")
    else:
        ck = a[0] if len(a) > 0 else None
        hk = a[1] if len(a) > 1 else None
    return {"coldkey": _ss58(ck), "hotkey": _ss58(hk)}


def _take_changed(a):  # TakeDecreased/TakeIncreased: {coldkey, hotkey, take} or [coldkey, hotkey, take]
    # Subtensor emits these coldkey-first: Event::TakeIncreased(coldkey, hotkey, take)
    # / TakeDecreased(coldkey, hotkey, take). The variants are positional tuples, so
    # the list branch must read a[0]=coldkey, a[1]=hotkey (same order as DelegateAdded).
    if isinstance(a, dict):
        ck, hk = a.get("coldkey"), a.get("hotkey")
    else:
        ck = a[0] if len(a) > 0 else None
        hk = a[1] if len(a) > 1 else None
    return {"hotkey": _ss58(hk), "coldkey": _ss58(ck)}


def _hotkey_swapped(a):  # HotkeySwapped: {coldkey, old_hotkey, new_hotkey} or [coldkey, old_hotkey, new_hotkey]
    if isinstance(a, dict):
        ck, hk = a.get("coldkey"), a.get("new_hotkey")
    else:
        ck = a[0] if len(a) > 0 else None
        hk = a[2] if len(a) > 2 else None
    return {"coldkey": _ss58(ck), "hotkey": _ss58(hk)}


def _coldkey_swap(a):  # ColdkeySwapped: {old_coldkey, new_coldkey} or [old_coldkey, new_coldkey]
    if isinstance(a, dict):
        old_ck, new_ck = a.get("old_coldkey"), a.get("new_coldkey")
    else:
        old_ck = a[0] if len(a) > 0 else None
        new_ck = a[1] if len(a) > 1 else None
    # old_coldkey as coldkey (primary actor), new_coldkey as hotkey (target)
    return {"coldkey": _ss58(old_ck), "hotkey": _ss58(new_ck)}


EXTRACTORS = {
    "NeuronRegistered": _registered,
    "StakeAdded": _stake,
    "StakeRemoved": _stake,
    "StakeMoved": _moved,
    "AxonServed": _axon,
    "WeightsSet": _weights,
    "RootClaimed": _root,
    # Subnet lifecycle (#1816)
    "NetworkAdded": _net,
    "NetworkRemoved": _net,
    # Delegation (#1816)
    "DelegateAdded": _delegate_added,
    "TakeDecreased": _take_changed,
    "TakeIncreased": _take_changed,
    # Key rotation (#1816)
    "HotkeySwapped": _hotkey_swapped,
    "ColdkeySwapped": _coldkey_swap,
    # Balances pallet — native TAO transfers between accounts (#1814)
    "Transfer": _transfer,
}


def _aura_slot(data):
    """The u64 LE Aura slot from a PreRuntime digest payload, across the shapes
    substrate-interface returns it in — else None.

    The 8-byte slot arrives as raw ``bytes``, a ``0x…`` hex string, OR a raw ``str``
    that is substrate-interface's UTF-8 decode of those bytes (NOT hex). The original
    code assumed hex and ran ``bytes.fromhex`` on the raw str, which raised and — via
    the caller's broad ``except`` — silently produced ``author = NULL``. Verified on
    finney #4000000 (spec 202): slot bytes ``4eca9508…`` arrive as the str ``'Nʕ\\x08…'``
    (the ``ʕ`` is U+0295, so latin-1 can't encode it — only UTF-8 round-trips it back
    to the original bytes). Takes the first 8 bytes; returns None on any drift.
    """
    try:
        if isinstance(data, (bytes, bytearray)):
            raw = bytes(data)
        elif isinstance(data, str):
            raw = bytes.fromhex(data[2:]) if data.startswith("0x") else data.encode("utf-8")
        else:
            return None
    except (ValueError, UnicodeError):
        return None
    if len(raw) != 8:
        return None
    return int.from_bytes(raw, "little")


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
                slot = _aura_slot(data)
                if slot is None:
                    return None
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
    try:
        rt = s.get_block_runtime_version(block_hash=bh)
        spec_version = rt.get("specVersion") or rt.get("spec_version") if isinstance(rt, dict) else None
    except Exception:
        spec_version = None
    return {
        "block_number": bn,
        "block_hash": str(bh),
        "parent_hash": str(parent_hash) if parent_hash is not None else None,
        "author": _block_author(s, bh, header),
        "extrinsic_count": extrinsic_count,
        "event_count": event_count,
        "spec_version": spec_version,
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


def _safe_json(v):
    """Best-effort JSON serialization of a decoded call_args value.
    Returns None if the value cannot be serialized (e.g. contains non-JSON
    substrate objects). NEVER raises."""
    try:
        return json.dumps(v, separators=(",", ":"))
    except (TypeError, ValueError):
        return None


def _extrinsic_call(value):
    """Best-effort (call_module, call_function, call_args_json) from a decoded
    extrinsic, else (None, None, None). call_args_json is a compact JSON string
    of the decoded arguments or None on shape drift/non-serializable. NEVER raises.
    """
    try:
        call = value.get("call") if isinstance(value, dict) else None
        if not isinstance(call, dict):
            return (None, None, None)
        cm = call.get("call_module")
        cf = call.get("call_function")
        ca = call.get("call_args")
        return (
            cm if isinstance(cm, str) else None,
            cf if isinstance(cf, str) else None,
            _safe_json(ca) if ca is not None else None,
        )
    except Exception:
        return (None, None, None)


def _fee_map(events):
    """Map extrinsic_index -> fee_tao from TransactionPayment.TransactionFeePaid events.

    Substrate emits one TransactionPayment.TransactionFeePaid per fee-paying extrinsic
    (fields: who, actual_fee, tip). Inherents and unsigned extrinsics do not emit it.
    Correlated by extrinsic_idx (same ApplyExtrinsic phase as ExtrinsicSuccess/Failed).
    NEVER raises.
    """
    out = {}
    try:
        for ev in events:
            v = ev.value if isinstance(ev.value, dict) else {}
            if v.get("phase") != "ApplyExtrinsic":
                continue
            e = v.get("event", {}) if isinstance(v.get("event"), dict) else {}
            if e.get("module_id") != "TransactionPayment":
                continue
            if e.get("event_id") != "TransactionFeePaid":
                continue
            idx = v.get("extrinsic_idx")
            if not isinstance(idx, int) or idx < 0:
                continue
            attrs = e.get("attributes")
            if isinstance(attrs, dict):
                fee_rao = attrs.get("actual_fee")
            elif isinstance(attrs, list) and len(attrs) > 1:
                fee_rao = attrs[1]  # [who, actual_fee, tip]
            else:
                fee_rao = None
            if fee_rao is not None:
                out[idx] = _tao(fee_rao)
    except Exception:
        return out
    return out


def _tip_map(events):
    """Map extrinsic_index -> tip_tao from TransactionPayment.TransactionFeePaid events (#1855).

    tip is the priority tip the signer added on top of the inclusion fee (the 3rd
    field of TransactionFeePaid: [who, actual_fee, tip]). Separate from fee_tao —
    most extrinsics tip 0. Correlated by extrinsic_idx, same as _fee_map. NEVER raises.
    """
    out = {}
    try:
        for ev in events:
            v = ev.value if isinstance(ev.value, dict) else {}
            if v.get("phase") != "ApplyExtrinsic":
                continue
            e = v.get("event", {}) if isinstance(v.get("event"), dict) else {}
            if e.get("module_id") != "TransactionPayment":
                continue
            if e.get("event_id") != "TransactionFeePaid":
                continue
            idx = v.get("extrinsic_idx")
            if not isinstance(idx, int) or idx < 0:
                continue
            attrs = e.get("attributes")
            if isinstance(attrs, dict):
                tip_rao = attrs.get("tip")
            elif isinstance(attrs, list) and len(attrs) > 2:
                tip_rao = attrs[2]  # [who, actual_fee, tip]
            else:
                tip_rao = None
            if tip_rao is not None:
                out[idx] = _tao(tip_rao)
    except Exception:
        return out
    return out


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
    fee_map = _fee_map(events)
    tip_map = _tip_map(events)
    for extrinsic_index, ext in enumerate(extrinsics):
        try:
            value = ext.value if ext is not None else None
            if not isinstance(value, dict):
                continue  # an undecodable extrinsic — skip this row only
            xhash = value.get("extrinsic_hash")
            call_module, call_function, call_args = _extrinsic_call(value)
            rows.append(
                {
                    "block_number": bn,
                    "extrinsic_index": extrinsic_index,
                    "extrinsic_hash": str(xhash) if xhash is not None else None,
                    "signer": _extrinsic_signer(value),
                    "call_module": call_module,
                    "call_function": call_function,
                    "call_args": call_args,
                    "success": success_map.get(extrinsic_index),
                    "fee_tao": fee_map.get(extrinsic_index),
                    "tip_tao": tip_map.get(extrinsic_index),
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
        "alpha_amount": f.get("alpha_amount"),
    }


def event_rows_for_events(bn, events, observed_at):
    """Extract account_events rows for one block.

    Kept as whole-block units so producer-side row chunking never advances the
    staged cursor past a partially emitted block. Shape drift on individual events
    is handled by extract() and skipped, matching the historical inline loop.
    """
    rows = []
    for event_index, ev in enumerate(events):
        v = ev.value if isinstance(ev.value, dict) else {}
        e = v.get("event", {}) if isinstance(v.get("event"), dict) else {}
        if e.get("module_id") not in ("SubtensorModule", "Balances"):
            continue
        eid = e.get("event_id")
        ent = extract(eid, e.get("attributes"))
        if ent is None:
            continue
        # Link the event to the extrinsic that emitted it (#1849): the
        # ApplyExtrinsic-phase extrinsic_idx (the same field _fee_map /
        # _extrinsic_success_map correlate on). Initialization / Finalization
        # phase events have no extrinsic — store null.
        xidx = v.get("extrinsic_idx") if v.get("phase") == "ApplyExtrinsic" else None
        if not isinstance(xidx, int) or xidx < 0:
            xidx = None
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
                "alpha_amount": ent["alpha_amount"],
                "observed_at": observed_at,
                "extrinsic_index": xidx,
            }
        )
    return rows


def _can_append_event_block(rows, block_rows, max_rows=MAX_EVENT_ROWS):
    """Whether the next block's account_events fit in this staged batch."""
    return len(rows) + len(block_rows) <= max_rows

def _lag_alert_needed(head_bn, cursor, window=WINDOW, horizon=PRUNE_HORIZON):
    """True when the cursor is far enough behind the finalized head that un-fetched
    blocks risk being pruned before the next run.

    No alert on a cold cursor (nothing to lag). And none when the overlap window
    already covers the whole prune horizon (``horizon - window <= 0``): blocks can
    then never age out unseen, so the bare ``horizon - window`` threshold would be
    zero/negative and otherwise fire on every run (even at lag 0).
    """
    if cursor is None:
        return False
    overlap_floor = horizon - window
    if overlap_floor <= 0:
        return False
    return (head_bn - cursor) >= overlap_floor


def _emit_lag_alert(head_bn, cursor):
    """If the cursor is within ~one window of the prune horizon, warn loudly.

    Writes a GitHub Actions `::warning::` (picked up in the run log/annotations)
    AND posts to METAGRAPH_ALERT_WEBHOOK_URL when configured, so a poller that is
    falling behind faster than it can catch up is VISIBLE before blocks are pruned
    out from under it — not silently lost. No-op on a cold cursor (nothing to lag).
    """
    if not _lag_alert_needed(head_bn, cursor):
        return
    lag = head_bn - cursor
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
    start, end = compute_scan_range(cursor, head_bn, WINDOW, MAX_LOOKBACK, BATCH_BLOCKS)
    _emit_lag_alert(head_bn, cursor)

    rows = []
    blocks = []
    extrinsics = []
    scanned = 0
    skipped = 0
    for bn in range(start, end + 1):
        observed_at = head_ts - (head_bn - bn) * BLOCK_MS
        try:
            bh = s.get_block_hash(bn)
            events = s.query("System", "Events", block_hash=bh)
        except Exception as e:  # pruned/transient → skip this block, keep going
            skipped += 1
            sys.stderr.write(f"block {bn}: skip ({repr(e)[:80]})\n")
            continue
        scanned += 1
        block_event_rows = event_rows_for_events(bn, events, observed_at)
        if not _can_append_event_block(rows, block_event_rows):
            end = bn - 1
            break
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
        rows.extend(block_event_rows)

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

    # Next-cursor sidecar: the highest block we covered in THIS bounded batch.
    # The workflow stages the events first, then — only on a successful stage —
    # promotes this to events/cursor.json in R2. Long archive recovery therefore
    # advances over multiple bounded pending objects instead of one oversized
    # object; compute_from_block still re-scans the overlap window once current.
    next_cursor = max(end, cursor) if cursor is not None else end
    os.makedirs(os.path.dirname(CURSOR_OUT) or ".", exist_ok=True)
    with open(CURSOR_OUT, "w") as fh:
        json.dump({"block_number": next_cursor}, fh)

    sys.stderr.write(
        f"wrote {len(rows)} events from blocks {start}..{end} (head={head_bn}) "
        f"(cursor_in={cursor}, scanned {scanned}, skipped {skipped}) -> {OUT}; "
        f"wrote {len(blocks)} block rows -> {BLOCKS_OUT}; "
        f"wrote {len(extrinsics)} extrinsic rows -> {EXTRINSICS_OUT}; "
        f"next cursor {next_cursor} -> {CURSOR_OUT}\n"
    )


if __name__ == "__main__":
    main()
