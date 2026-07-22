// Block explorer (#1345 epic, second vertical slice): the D1 `extrinsics` tier —
// first-party per-extrinsic (transaction) records decoded DIRECTLY from finney by
// the same chain-direct poller (scripts/fetch-events.py) that fills account_events
// + blocks, NOT Taostats. This module holds the load contract, the row→API
// shaping, and the retention prune. Pure + exported for tests; the Worker runs
// the D1 I/O.
import { DAY_MS } from "../workers/config.ts";
import {
  BLOCK_PAGINATION,
  clampLimit,
  clampOffset,
} from "../workers/request-params.ts";
import { decodeCursor, encodeCursor } from "./cursor.ts";
import { normalizePostgresValue } from "./scale-normalize.ts";
import { decodePostgresCallArgs } from "./postgres-call-args.mjs";
import { decodeEthereumEvmCallArgs } from "./indexer-rs-ethereum-decode.ts";
import { parseJsonPreservingBigInts } from "./big-int-safe-json.ts";
import { decodeBTreeSetFields } from "./postgres-collection-normalize.ts";

type D1Runner = (
  sql: string,
  params: unknown[],
) => Promise<Array<Record<string, unknown>>>;

// Was the D1 prune-cron's retention window (a 2026-07-10 capacity emergency:
// ~101k rows/day, ~9.0GB of D1's hard 10GB-per-database cap already used).
// D1's write path + prune cron are retired (#4772 D1 chain-data retirement) --
// this constant now only bounds loadExtrinsics' query-floor short-circuit
// below (an impossible ?to= before this floor is a guaranteed empty page,
// answered without a query), kept at the same 5-day value rather than widened,
// since Postgres (self-hosted, no capacity cap) is the actual serving tier now.
export const EXTRINSIC_RETENTION_MS = 5 * 24 * 60 * 60 * 1000;

function toIso(ms: unknown): string | null {
  // D1 can return the INTEGER observed_at as a numeric string; a bare
  // Number.isFinite(ms) is false for a string, so the old form dropped a real
  // timestamp to null. Coerce first, and require n > 0 so a null/blank/invalid
  // cell stays null instead of epoch 1970. Mirrors the blocks toIso fix (#2708).
  if (ms == null) return null;
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  // A finite but out-of-range epoch (|ms| > 8.64e15, the JS Date limit) makes
  // new Date(n).toISOString() throw a RangeError, which would 500 the whole
  // extrinsics feed on a single corrupt observed_at cell. Drop it to null
  // instead, mirroring the getTime() range guard in the stake-flow coerceEpochMs.
  const date = new Date(n);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

// Coerce a chain-position cell (block_number / extrinsic_index) to a
// non-negative integer, or null when missing, non-finite, or negative. D1 can
// return an INTEGER column as a numeric string, so a bare `?? null` pass-through
// would silently leak the string into the API payload and break downstream
// arithmetic/comparisons. Mirrors the `toBlockNumber` already applied in
// account-events.mjs / chain-analytics.ts and the `toBlockNumber` added to
// blocks.mjs in #2435.
function toChainPosition(value: unknown): number | null {
  if (value == null) return null;
  // Blank D1 cells coerce via Number("") → 0; trim rejects "" / whitespace-only.
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

// Coerce a TAO amount cell (fee_tao / tip_tao, D1 REAL columns) to a number
// rounded to rao precision (9 dp), or null when missing/non-finite. D1 can
// return a REAL column as a numeric string, so a bare `?? null` pass-through
// would leak the string form into the ["number","null"] contract field and
// serve unrounded float noise. Mirrors toTaoOrNull in account-events.mjs
// (#2662) and the coercion in formatRegistration (#2487).
function toTaoOrNull(value: unknown): number | null {
  if (value == null) return null;
  // Blank D1 cells coerce via Number("") → 0; trim rejects "" / whitespace-only.
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 1e9) / 1e9 : null;
}

// ---- Extrinsic API builders ------------------------------------------------
// The columns the extrinsic handlers SELECT for an extrinsic row.
export const EXTRINSIC_READ_COLUMNS =
  "block_number, extrinsic_index, extrinsic_hash, signer, call_module, call_function, call_args, success, fee_tao, tip_tao, observed_at";

export interface ExtrinsicApi {
  block_number: number | null;
  extrinsic_index: number | null;
  extrinsic_hash: unknown;
  signer: unknown;
  call_module: unknown;
  call_function: unknown;
  call_args: unknown;
  success: boolean | null;
  fee_tao: number | null;
  tip_tao: number | null;
  observed_at: string | null;
}

// One D1 extrinsics row → a clean API extrinsic object. Null-safe on junk/sparse
// rows. success is normalized to a boolean (null when undeterminable).
export function formatExtrinsic(
  row: Record<string, unknown> | null | undefined,
): ExtrinsicApi | null {
  if (!row || typeof row !== "object") return null;
  let call_args: unknown = null;
  if (row.call_args != null) {
    try {
      // decodePostgresCallArgs (#4691) MUST run before normalizePostgresValue
      // (#4690) -- it needs the pristine raw nested-call shape to reconstruct
      // correctly (see its own file header for why running it second would
      // silently lose a genuinely zero-argument nested call). Ethereum/EVM
      // decode (#4692) and the BTreeSet unwrap (#4693) can safely run last --
      // neither earlier pass touches the shapes they target (verified: the
      // newtype-scalar rule only partially/coincidentally collapses a
      // SINGLE-element BTreeSet as an unrelated side effect -- see
      // postgres-collection-normalize.ts's header for why that doesn't
      // conflict with running this pass afterward). All four are no-ops on
      // D1's own call_args shape (an array of {name,type,value} descriptors)
      // -- safe to apply unconditionally regardless of which serving tier
      // produced this row. This is a genuine guarantee, not an assumption:
      // normalizePostgresValue (#4724) reads each D1 descriptor's own `type`
      // string before touching its `value`, so a collection-typed field
      // (Vec<T>/BTreeSet<T>/etc) is preserved as an array at ANY element
      // count -- decodeBTreeSetFields is then a true no-op on D1 rows
      // regardless, since D1's call_args never becomes the flat
      // {fieldName: value} object shape that function's own Array.isArray
      // early-return requires it to skip.
      //
      // u64/u128 precision: parseJsonPreservingBigInts now runs for EVERY
      // extrinsic, not just the call types indexer-rs-ethereum-decode.ts
      // decodes -- widening the #4692 review fix that was deliberately
      // scoped narrow at the time (see wrangler.jsonc's
      // METAGRAPH_EXTRINSICS_SOURCE comment for the original reasoning). An
      // exhaustive live audit (2026-07-14/15) found the plain-JSON.parse
      // rounding bug reaches far more call types than the one "accepted"
      // fixture (SubtensorModule.register's PoW nonce) previously pinned:
      // confirmed live on SubtensorModule.set_children's per-child
      // proportion, SubtensorModule.set_root_weights.version_key,
      // SubtensorModule.faucet's nonce, and a nested Utility.force_batch ->
      // SubtensorModule.remove_stake.amount_unstaked reached through
      // Proxy.proxy -- i.e. any u64-shaped field on any call type can hit
      // this, not a fixed known set. parseJsonPreservingBigInts is a
      // documented no-op on any JSON text with no integer literal past
      // Number.MAX_SAFE_INTEGER (see its own header) -- safe to apply
      // unconditionally; the only real effect is that a field large enough
      // to have been silently losing precision now arrives as an exact
      // decimal STRING instead of a rounded number, matching how
      // decodeU256Limbs already represents U256 values for exactly this
      // reason. See tests/extrinsics.test.mjs for the fixtures this fix
      // resolves.
      call_args = decodeBTreeSetFields(
        row.call_module,
        row.call_function,
        decodeEthereumEvmCallArgs(
          row.call_module,
          row.call_function,
          normalizePostgresValue(
            decodePostgresCallArgs(
              parseJsonPreservingBigInts(row.call_args as string),
              // postgres-call-args.mjs isn't converted yet (Phase 3) -- its
              // untyped `topCall = null` default param infers as exactly
              // `null`, so the real object needs a cast here.
              {
                call_module: row.call_module,
                call_function: row.call_function,
              } as unknown as null,
            ),
          ),
        ),
      );
    } catch {
      call_args = null;
    }
  }
  return {
    block_number: toChainPosition(row.block_number),
    extrinsic_index: toChainPosition(row.extrinsic_index),
    extrinsic_hash: row.extrinsic_hash ?? null,
    signer: row.signer ?? null,
    call_module: row.call_module ?? null,
    call_function: row.call_function ?? null,
    call_args,
    // D1 can return the `success` INTEGER column as a numeric string ("1"/"0"),
    // same as block_number/extrinsic_index above — a bare `=== 1` would leave a
    // successful extrinsic mislabeled false. Number()-coerce first, mirroring
    // toD1Flag in account-events.mjs (#2487).
    success: row.success == null ? null : Number(row.success) === 1,
    // fee_tao / tip_tao (D1 REAL columns) — coerce through toTaoOrNull so a
    // numeric string never leaks the string form into the ["number","null"]
    // payload, matching formatAccountEvent (#2662) and the sibling formatters.
    fee_tao: toTaoOrNull(row.fee_tao),
    tip_tao: toTaoOrNull(row.tip_tao),
    observed_at: toIso(row.observed_at),
  };
}

export interface ExtrinsicDetail {
  schema_version: 1;
  ref: unknown;
  extrinsic: ExtrinsicApi | null;
  events: unknown[];
}

// Per-extrinsic detail artifact. `extrinsic` is null when the ref didn't resolve
// (cold store or unknown extrinsic) — schema-stable, never throws (mirrors the
// block detail route's `block:null`). `events` are the indexed account_events this
// extrinsic emitted (#1849), already formatted + bounded by the handler; defaults
// to [] (empty for pre-migration rows, non-ApplyExtrinsic events, or a cold store).
export function buildExtrinsic(
  row: Record<string, unknown> | null | undefined,
  ref: unknown,
  events: unknown[] = [],
): ExtrinsicDetail {
  return {
    schema_version: 1,
    ref: ref ?? null,
    extrinsic: formatExtrinsic(row),
    events: events || [],
  };
}

// Recent-extrinsic feed artifact (newest first). Null-safe on a cold/absent store
// (returns a schema-stable zero). next_cursor (#1851) is the opaque keyset token
// for the next page, or null at end-of-window; the caller computes it.
export const EXTRINSICS_CSV_COLUMNS = [
  "extrinsic_id",
  "block_number",
  "signer",
  "call_module",
  "call_function",
  "success",
];

export interface ExtrinsicCsvRow {
  extrinsic_id: string | null;
  block_number: unknown;
  signer: unknown;
  call_module: unknown;
  call_function: unknown;
  success: unknown;
}

// Narrow CSV projection for the extrinsics feed (#2529): composite id plus the
// core call metadata columns requested by the bounty issue.
export function extrinsicsToCsvRows(
  extrinsics: Array<Record<string, unknown>> | null | undefined,
): ExtrinsicCsvRow[] {
  return (extrinsics || []).map((row) => ({
    extrinsic_id:
      row?.block_number != null && row?.extrinsic_index != null
        ? `${row.block_number}-${row.extrinsic_index}`
        : null,
    block_number: row?.block_number ?? null,
    signer: row?.signer ?? null,
    call_module: row?.call_module ?? null,
    call_function: row?.call_function ?? null,
    success: row?.success ?? null,
  }));
}

export interface ExtrinsicFeed {
  schema_version: 1;
  extrinsic_count: number;
  limit: number | null;
  offset: number | null;
  next_cursor: string | null;
  extrinsics: ExtrinsicApi[];
}

export function buildExtrinsicFeed(
  rows: Array<Record<string, unknown>> | null | undefined,
  {
    limit,
    offset,
    nextCursor,
  }: {
    limit?: number | null;
    offset?: number | null;
    nextCursor?: string | null;
  } = {},
): ExtrinsicFeed {
  const extrinsics = (rows || [])
    .map(formatExtrinsic)
    .filter((e): e is ExtrinsicApi => Boolean(e));
  return {
    schema_version: 1,
    extrinsic_count: extrinsics.length,
    limit: limit ?? null,
    offset: offset ?? null,
    next_cursor: nextCursor ?? null,
    extrinsics,
  };
}

export interface AccountExtrinsicFeed {
  schema_version: 1;
  ss58: unknown;
  extrinsic_count: number;
  limit: number | null;
  offset: number | null;
  next_cursor: string | null;
  extrinsics: ExtrinsicApi[];
}

// Per-account signed-extrinsic feed artifact (#1844, newest first). The account's
// extrinsics are matched by the extrinsic SIGNER only, NOT the hotkey or coldkey
// union the account_events routes use — `extrinsics` carries a single `signer`
// column. extrinsic_count is the PAGE count (matches the feed + account-events
// convention), not a grand total. Null-safe on a cold store.
export function buildAccountExtrinsics(
  rows: Array<Record<string, unknown>> | null | undefined,
  ss58: unknown,
  {
    limit,
    offset,
    nextCursor,
  }: {
    limit?: number | null;
    offset?: number | null;
    nextCursor?: string | null;
  } = {},
): AccountExtrinsicFeed {
  const extrinsics = (rows || [])
    .map(formatExtrinsic)
    .filter((e): e is ExtrinsicApi => Boolean(e));
  return {
    schema_version: 1,
    ss58,
    extrinsic_count: extrinsics.length,
    limit: limit ?? null,
    offset: offset ?? null,
    next_cursor: nextCursor ?? null,
    extrinsics,
  };
}

export interface BlockExtrinsicFeed {
  schema_version: 1;
  ref: unknown;
  block_number: unknown;
  extrinsic_count: number;
  limit: number | null;
  offset: number | null;
  extrinsics: ExtrinsicApi[];
}

// Per-block extrinsics sub-resource artifact (#1845): the extrinsics in one block,
// in natural read order (extrinsic_index ASC) — note this differs from the global
// feed's newest-first DESC; both are covered by the (block_number, extrinsic_index)
// PK. block_number is null + extrinsics:[] when the ref didn't resolve (cold store
// or unknown block) — schema-stable, never throws.
export function buildBlockExtrinsics(
  rows: Array<Record<string, unknown>> | null | undefined,
  ref: unknown,
  blockNumber: unknown,
  { limit, offset }: { limit?: number | null; offset?: number | null } = {},
): BlockExtrinsicFeed {
  const extrinsics = (rows || [])
    .map(formatExtrinsic)
    .filter((e): e is ExtrinsicApi => Boolean(e));
  return {
    schema_version: 1,
    ref: ref ?? null,
    block_number: blockNumber ?? null,
    extrinsic_count: extrinsics.length,
    limit: limit ?? null,
    offset: offset ?? null,
    extrinsics,
  };
}

// ---- Extrinsic D1 read paths -----------------------------------------------
// One source of truth for the extrinsics SQL + pagination, shared by the REST
// handlers and the MCP extrinsic tools. `d1` is a
// (sql, params) => Promise<rows[]> runner; a cold/unbound DB yields [].

export interface LoadExtrinsicsOptions {
  signer?: string | null;
  callModule?: string | null;
  callFunction?: string | null;
  block?: number | null;
  blockStart?: number | null;
  blockEnd?: number | null;
  from?: number | null;
  to?: number | null;
  success?: boolean | null;
  callHash?: string | null;
  limit?: number | string | null;
  offset?: number | string | null;
  cursor?: unknown;
  nowMs?: number;
}

// Filtered extrinsic feed (newest first) with keyset cursor support (#1851).
// Supported filters mirror GET /api/v1/extrinsics (#1846): signer, callModule,
// callFunction, block, blockStart/blockEnd, from/to (observed_at epoch-ms),
// success (true|false only; omit for no filter), and callHash (#4322 — see
// below). A cursor takes precedence over offset when present — uses a
// (block_number, extrinsic_index) row-value seek.
export async function loadExtrinsics(
  d1: D1Runner,
  {
    signer,
    callModule,
    callFunction,
    block,
    blockStart,
    blockEnd,
    from,
    to,
    success,
    callHash,
    limit,
    offset,
    cursor,
    nowMs = Date.now(),
  }: LoadExtrinsicsOptions = {},
): Promise<ExtrinsicFeed> {
  const lim = clampLimit(limit, BLOCK_PAGINATION);
  const off = clampOffset(offset);
  const observedFloorMs = nowMs - EXTRINSIC_RETENTION_MS;
  if (
    (blockStart != null && blockEnd != null && blockStart > blockEnd) ||
    (from != null && from > nowMs + DAY_MS) ||
    (to != null && to < observedFloorMs) ||
    (from != null && to != null && from > to)
  ) {
    return buildExtrinsicFeed([], {
      limit: lim,
      offset: off,
      nextCursor: null,
    });
  }
  const conds: string[] = [];
  const params: unknown[] = [];
  const hasBlockFilter = block != null;
  const hasSignerFilter = Boolean(signer);
  const hasCallModuleFilter = Boolean(callModule);
  const hasCallFunctionFilter = Boolean(callFunction);
  const hasEqualityFilter =
    hasSignerFilter || hasCallModuleFilter || hasCallFunctionFilter;
  if (hasBlockFilter) {
    conds.push("block_number = ?");
    params.push(block);
  }
  if (hasSignerFilter) {
    conds.push("signer = ?");
    params.push(signer);
  }
  if (hasCallModuleFilter) {
    conds.push("call_module = ?");
    params.push(callModule);
  }
  if (hasCallFunctionFilter) {
    conds.push("call_function = ?");
    params.push(callFunction);
  }
  // #4322 (Multisig approval-chain linking): call_hash isn't its own column —
  // it lives inside call_args' decoded JSON, either as a top-level arg
  // (Multisig.approve_as_multi/cancel_as_multi only carry the hash, not the
  // full call) or nested inside a wrapped call's own call_hash field
  // (Multisig.as_multi carries the full call, decoded the same way batch's
  // inner calls are — see docs/block-explorer-data-model.md's "Nested-call
  // decode depth" note). A LIKE scan of the raw JSON text is the simplest
  // correct match for either shape without a schema change; always pair this
  // filter with callModule (the caller does) so it scans a narrow slice, not
  // the whole table. The quoted match (`"<hash>"`) requires the hash to
  // appear as an actual JSON string value, not an arbitrary substring.
  const hasCallHashFilter = Boolean(callHash);
  if (hasCallHashFilter) {
    conds.push("call_args LIKE ?");
    params.push(`%"${callHash}"%`);
  }
  const hasSuccessFilter = success === true || success === false;
  if (success === true) {
    conds.push("success = ?");
    params.push(1);
  } else if (success === false) {
    conds.push("success = ?");
    params.push(0);
  }
  const hasBlockRangeFilter = blockStart != null || blockEnd != null;
  if (blockStart != null) {
    conds.push("block_number >= ?");
    params.push(blockStart);
  }
  if (blockEnd != null) {
    conds.push("block_number <= ?");
    params.push(blockEnd);
  }
  if (from != null) {
    conds.push("observed_at >= ?");
    params.push(from);
  }
  if (to != null) {
    conds.push("observed_at <= ?");
    params.push(to);
  }
  const cur = decodeCursor(cursor, 2);
  const useCursor = Boolean(cur);
  if (useCursor && cur) {
    conds.push("(block_number, extrinsic_index) < (?, ?)");
    params.push(cur[0], cur[1]);
  }
  const effectiveFromMs = from ?? observedFloorMs;
  const effectiveToMs = to ?? nowMs + DAY_MS;
  const hasNarrowObservedWindow =
    (from != null || to != null) && effectiveToMs - effectiveFromMs <= DAY_MS;
  const forceObservedOrderIndex =
    hasNarrowObservedWindow &&
    !hasBlockFilter &&
    !hasEqualityFilter &&
    !hasSuccessFilter &&
    !hasBlockRangeFilter &&
    !useCursor;
  const forceModuleIndex =
    hasCallModuleFilter &&
    !forceObservedOrderIndex &&
    !hasBlockFilter &&
    !hasBlockRangeFilter &&
    !hasSignerFilter &&
    !hasCallFunctionFilter &&
    !hasCallHashFilter &&
    !hasSuccessFilter &&
    from == null &&
    to == null &&
    !useCursor;
  let sql = `SELECT ${EXTRINSIC_READ_COLUMNS} FROM extrinsics`;
  if (forceObservedOrderIndex)
    sql += " INDEXED BY idx_extrinsics_observed_order";
  else if (forceModuleIndex) sql += " INDEXED BY idx_extrinsics_module_block";
  if (conds.length) sql += ` WHERE ${conds.join(" AND ")}`;
  sql += " ORDER BY block_number DESC, extrinsic_index DESC LIMIT ?";
  params.push(lim);
  if (!useCursor) {
    sql += " OFFSET ?";
    params.push(off);
  }
  const rows = await d1(sql, params);
  const last = rows.length === lim ? rows[rows.length - 1] : null;
  const nextCursor = last
    ? encodeCursor([
        last.block_number as number,
        last.extrinsic_index as number,
      ])
    : null;
  return buildExtrinsicFeed(rows, { limit: lim, offset: off, nextCursor });
}
