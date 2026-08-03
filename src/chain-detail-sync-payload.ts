// Parsing + validation for one chain-detail sync batch (#9208).
//
// Kept out of workers/data-api.ts on purpose: the handler there owns auth, body
// size and the response, and every other sync route's validator is a pile of
// predicates wedged between the two. This payload is four nested row shapes
// with real nullability rules, so it gets its own module -- and, being pure,
// it is testable without a Request, an Env or a database.
//
// TRUST POSTURE, same as every sync route in this family: the token proves WHO
// is posting, never WHAT. The producer is our own poller lane, but a payload
// that reaches D1 unchecked is a payload that can put an unqueryable string in
// `phase`, a float in an INTEGER column, or a pallet-qualified `event_kind`
// that silently breaks `?kind=` parity with the lakehouse. So every field is
// checked, and a batch with ONE bad row is rejected whole rather than partially
// applied -- a half-written block is exactly the ambiguous state
// `chain_detail_blocks` exists to make impossible.
//
// NULLABILITY IS NOT LENIENCY. `signer: null` means an inherent or unsigned
// extrinsic, `success: null` means no System.ExtrinsicSuccess/Failed correlated
// to that index, `extrinsic_index: null` on an event means the Finalization or
// Initialization phase. Each is a real, distinct fact -- so the validator
// accepts null for exactly those fields and rejects it everywhere else, rather
// than accepting null anywhere and letting the read path guess.

import { CHAIN_EVENT_PHASES } from "./chain-detail-d1-write.ts";

type Row = Record<string, unknown>;

/** ~662 KiB for the producer's 2-block batch, measured; 16 MiB is generous
 * headroom over that without inviting a pathological body. */
export const CHAIN_DETAIL_SYNC_MAX_BODY_BYTES = 16_000_000;
/** The producer batches 2. A cap of 16 tolerates a catch-up burst after a
 * restart while bounding one request's write to something D1 can hold in a
 * single transaction. */
export const CHAIN_DETAIL_SYNC_MAX_BLOCKS = 16;
/** Real blocks carry up to ~1,300 rows across the three families; 16 blocks at
 * 4x that headroom still fits the binding's statement budget comfortably. */
export const CHAIN_DETAIL_SYNC_MAX_ROWS = 80_000;
/** 0x + 64 hex, the only block-hash shape finney produces. */
const BLOCK_HASH = /^0x[0-9a-f]{64}$/i;
/** An exact decimal, as a string. No exponent form: the producer emits plain
 * decimal, and accepting `1e21` here would store a value that Number() reads
 * back at a different precision than the string implies. */
const DECIMAL = /^-?\d+(\.\d+)?$/;
/** A pallet/method/variant identifier. Deliberately excludes `.` so a
 * pallet-qualified `event_kind` ("SubtensorModule.StakeAdded") is rejected: the
 * lakehouse column holds the bare variant, and a qualified value here would
 * make `?kind=StakeAdded` match on one tier and miss on the other. */
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function isIndex(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isEpochMs(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function isOptionalIndex(value: unknown): boolean {
  return value === null || isIndex(value);
}

function isOptionalText(value: unknown): boolean {
  return value === null || (typeof value === "string" && value.length <= 512);
}

function isOptionalDecimal(value: unknown): boolean {
  return value === null || (typeof value === "string" && DECIMAL.test(value));
}

/** call_args / args: a JSON-ENCODED STRING, never an object. The contract says
 * so, and it matters -- the column is TEXT and the formatters JSON.parse it, so
 * an object here would be stored as "[object Object]" by D1's binding. */
function isOptionalJsonText(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function isPlainObject(value: unknown): value is Row {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The 0/1 D1 stores for a three-valued boolean; null stays null. */
function toFlag(value: unknown): number | null {
  return value === null ? null : value ? 1 : 0;
}

export interface ChainDetailSyncRows {
  blockRows: Row[];
  extrinsicRows: Row[];
  chainEventRows: Row[];
  accountEventRows: Row[];
  /** Highest block_number in the batch -- what the ack reports. */
  head: number;
}

export type ChainDetailSyncParse =
  | { ok: true; rows: ChainDetailSyncRows }
  | { ok: false; error: string; status: 400 | 413 };

/**
 * Later wins, on the natural key. A batch that repeats a key is not an error
 * (the producer prefers re-sending over skipping, and a catch-up burst can
 * overlap itself), but two rows with the same key inside ONE multi-row upsert
 * is a shape worth not depending on SQLite's statement-internal conflict
 * ordering for. Resolving it here makes the statement deterministic.
 */
function dedupe(rows: Row[], keys: string[]): Row[] {
  const byKey = new Map<string, Row>();
  for (const row of rows) byKey.set(keys.map((k) => row[k]).join(":"), row);
  return [...byKey.values()];
}

function parseExtrinsic(raw: unknown, blockNumber: number): Row | string {
  if (!isPlainObject(raw)) return "extrinsics[] entries must be objects";
  if (raw.block_number !== blockNumber)
    return `an extrinsic's block_number must equal its block's (${blockNumber})`;
  if (!isIndex(raw.extrinsic_index)) return "extrinsic_index must be an index";
  if (!(
    raw.extrinsic_hash === null ||
    (typeof raw.extrinsic_hash === "string" &&
      BLOCK_HASH.test(raw.extrinsic_hash))
  ))
    return "extrinsic_hash must be 0x + 64 hex, or null";
  if (!isOptionalText(raw.signer)) return "signer must be a string or null";
  if (!isOptionalText(raw.call_module) || !isOptionalText(raw.call_function))
    return "call_module/call_function must be strings or null";
  if (!(raw.success === null || typeof raw.success === "boolean"))
    return "success must be a boolean or null";
  if (!isOptionalDecimal(raw.fee_tao) || !isOptionalDecimal(raw.tip_tao))
    return "fee_tao/tip_tao must be exact decimal strings, or null";
  if (!isOptionalJsonText(raw.call_args))
    return "call_args must be a JSON-encoded string, or null";
  if (!isEpochMs(raw.observed_at))
    return "an extrinsic's observed_at must be epoch ms";
  return {
    block_number: blockNumber,
    extrinsic_index: raw.extrinsic_index,
    extrinsic_hash: raw.extrinsic_hash,
    signer: raw.signer,
    call_module: raw.call_module,
    call_function: raw.call_function,
    success: toFlag(raw.success),
    fee_tao: raw.fee_tao,
    tip_tao: raw.tip_tao,
    call_args: raw.call_args,
    observed_at: raw.observed_at,
  };
}

function parseChainEvent(raw: unknown, blockNumber: number): Row | string {
  if (!isPlainObject(raw)) return "chain_events[] entries must be objects";
  if (raw.block_number !== blockNumber)
    return `a chain event's block_number must equal its block's (${blockNumber})`;
  if (!isIndex(raw.event_index)) return "event_index must be an index";
  if (typeof raw.pallet !== "string" || !IDENTIFIER.test(raw.pallet))
    return "pallet must be an identifier";
  if (typeof raw.method !== "string" || !IDENTIFIER.test(raw.method))
    return "method must be an identifier";
  if (!isOptionalJsonText(raw.args))
    return "args must be a JSON-encoded string, or null";
  if (typeof raw.phase !== "string" || !CHAIN_EVENT_PHASES.has(raw.phase))
    return `phase must be one of ${[...CHAIN_EVENT_PHASES].join(", ")}`;
  if (!isOptionalIndex(raw.extrinsic_index))
    return "a chain event's extrinsic_index must be an index or null";
  if (!isEpochMs(raw.observed_at))
    return "a chain event's observed_at must be epoch ms";
  return {
    block_number: blockNumber,
    event_index: raw.event_index,
    pallet: raw.pallet,
    method: raw.method,
    args: raw.args,
    phase: raw.phase,
    extrinsic_index: raw.extrinsic_index,
    observed_at: raw.observed_at,
  };
}

function parseAccountEvent(raw: unknown, blockNumber: number): Row | string {
  if (!isPlainObject(raw)) return "account_events[] entries must be objects";
  if (raw.block_number !== blockNumber)
    return `an account event's block_number must equal its block's (${blockNumber})`;
  if (!isIndex(raw.event_index)) return "event_index must be an index";
  if (!isOptionalIndex(raw.extrinsic_index))
    return "an account event's extrinsic_index must be an index or null";
  if (typeof raw.event_kind !== "string" || !IDENTIFIER.test(raw.event_kind))
    return "event_kind must be a bare variant name, not pallet-qualified";
  if (!isOptionalText(raw.hotkey) || !isOptionalText(raw.coldkey))
    return "hotkey/coldkey must be strings or null";
  if (!isOptionalIndex(raw.netuid) || !isOptionalIndex(raw.uid))
    return "netuid/uid must be indexes or null";
  if (
    !isOptionalDecimal(raw.amount_tao) ||
    !isOptionalDecimal(raw.alpha_amount)
  )
    return "amount_tao/alpha_amount must be exact decimal strings, or null";
  if (!isEpochMs(raw.observed_at))
    return "an account event's observed_at must be epoch ms";
  return {
    block_number: blockNumber,
    event_index: raw.event_index,
    extrinsic_index: raw.extrinsic_index,
    event_kind: raw.event_kind,
    hotkey: raw.hotkey,
    coldkey: raw.coldkey,
    netuid: raw.netuid,
    uid: raw.uid,
    amount_tao: raw.amount_tao,
    alpha_amount: raw.alpha_amount,
    observed_at: raw.observed_at,
  };
}

/**
 * One parsed, validated batch, already shaped into the exact column sets
 * src/chain-detail-d1-write.ts binds.
 *
 * `syncedAt` is passed in rather than read from Date.now() here so the whole
 * module stays a pure function of its input -- the handler owns the clock.
 */
export function parseChainDetailSync(
  body: unknown,
  syncedAt: number,
): ChainDetailSyncParse {
  const blocks = isPlainObject(body) ? body.blocks : null;
  if (!Array.isArray(blocks) || blocks.length === 0)
    return {
      ok: false,
      error: "body must be {blocks:[...]} with at least one block",
      status: 400,
    };
  if (blocks.length > CHAIN_DETAIL_SYNC_MAX_BLOCKS)
    return {
      ok: false,
      error: `at most ${CHAIN_DETAIL_SYNC_MAX_BLOCKS} blocks per request`,
      status: 413,
    };

  const blockRows: Row[] = [];
  let extrinsicRows: Row[] = [];
  let chainEventRows: Row[] = [];
  let accountEventRows: Row[] = [];
  let head = -1;

  for (const block of blocks) {
    if (!isPlainObject(block))
      return {
        ok: false,
        error: "blocks[] entries must be objects",
        status: 400,
      };
    const blockNumber = block.block_number;
    if (!isIndex(blockNumber))
      return { ok: false, error: "block_number must be an index", status: 400 };
    if (
      typeof block.block_hash !== "string" ||
      !BLOCK_HASH.test(block.block_hash)
    )
      return {
        ok: false,
        error: "block_hash must be 0x + 64 hex",
        status: 400,
      };
    if (!isEpochMs(block.observed_at))
      return { ok: false, error: "observed_at must be epoch ms", status: 400 };
    if (!isIndex(block.spec_version))
      return {
        ok: false,
        error: "spec_version must be a non-negative integer",
        status: 400,
      };
    const { extrinsics, chain_events, account_events } = block;
    if (
      !Array.isArray(extrinsics) ||
      !Array.isArray(chain_events) ||
      !Array.isArray(account_events)
    )
      return {
        ok: false,
        error:
          "each block needs extrinsics[], chain_events[] and account_events[]",
        status: 400,
      };

    for (const raw of extrinsics) {
      const row = parseExtrinsic(raw, blockNumber);
      if (typeof row === "string")
        return { ok: false, error: row, status: 400 };
      extrinsicRows.push(row);
    }
    for (const raw of chain_events) {
      const row = parseChainEvent(raw, blockNumber);
      if (typeof row === "string")
        return { ok: false, error: row, status: 400 };
      chainEventRows.push(row);
    }
    for (const raw of account_events) {
      const row = parseAccountEvent(raw, blockNumber);
      if (typeof row === "string")
        return { ok: false, error: row, status: 400 };
      accountEventRows.push(row);
    }

    // The counts are the LANE's assertion of what the block held, recorded
    // alongside the rows so a later short read is detectable against them.
    blockRows.push({
      block_number: blockNumber,
      block_hash: block.block_hash,
      spec_version: block.spec_version,
      extrinsic_count: extrinsics.length,
      chain_event_count: chain_events.length,
      account_event_count: account_events.length,
      observed_at: block.observed_at,
      synced_at: syncedAt,
    });
    if (blockNumber > head) head = blockNumber;
  }

  const total =
    extrinsicRows.length + chainEventRows.length + accountEventRows.length;
  if (total > CHAIN_DETAIL_SYNC_MAX_ROWS)
    return {
      ok: false,
      error: `at most ${CHAIN_DETAIL_SYNC_MAX_ROWS} detail rows per request`,
      status: 413,
    };

  extrinsicRows = dedupe(extrinsicRows, ["block_number", "extrinsic_index"]);
  chainEventRows = dedupe(chainEventRows, ["block_number", "event_index"]);
  accountEventRows = dedupe(accountEventRows, ["block_number", "event_index"]);

  return {
    ok: true,
    rows: {
      blockRows: dedupe(blockRows, ["block_number"]),
      extrinsicRows,
      chainEventRows,
      accountEventRows,
      head,
    },
  };
}
