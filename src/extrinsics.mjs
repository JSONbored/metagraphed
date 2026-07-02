// Block explorer (#1345 epic, second vertical slice): the D1 `extrinsics` tier —
// first-party per-extrinsic (transaction) records decoded DIRECTLY from finney by
// the same chain-direct poller (scripts/fetch-events.py) that fills account_events
// + blocks, NOT Taostats. This module holds the load contract, the row→API
// shaping, and the retention prune. Pure + exported for tests; the Worker runs
// the D1 I/O.
import { DAY_MS } from "../workers/config.mjs";
import {
  BLOCK_PAGINATION,
  clampLimit,
  clampOffset,
} from "../workers/request-params.mjs";
import { decodeCursor, encodeCursor } from "./cursor.mjs";

// D1 safety-valve: 365-day retention prevents unbounded growth before the
// Postgres cold tier (#1519) ships. pruneExtrinsics runs in the HEALTH_PRUNE_CRON.
export const EXTRINSIC_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

// Columns written to extrinsics — THE load contract. scripts/fetch-events.py
// emits rows with exactly these keys; loadStagedExtrinsics binds them in this
// order. Values are always bound, never interpolated into SQL.
export const EXTRINSIC_INSERT_COLUMNS = [
  "block_number",
  "extrinsic_index",
  "extrinsic_hash",
  "signer",
  "call_module",
  "call_function",
  "call_args",
  "success",
  "fee_tao",
  // The priority tip (TransactionFeePaid 3rd field), in TAO (#1855). Separate
  // from fee_tao; most extrinsics tip 0. Nullable. 11 cols now → ROWS_PER_STMT
  // drops to 9 (11 x 9 = 99 bound params, under D1's 100 ceiling).
  "tip_tao",
  "observed_at",
];

function toIso(ms) {
  // D1 can return the INTEGER observed_at as a numeric string; a bare
  // Number.isFinite(ms) is false for a string, so the old form dropped a real
  // timestamp to null. Coerce first, and require n > 0 so a null/blank/invalid
  // cell stays null instead of epoch 1970. Mirrors the blocks toIso fix (#2708).
  if (ms == null) return null;
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
}

// Coerce a chain-position cell (block_number / extrinsic_index) to a
// non-negative integer, or null when missing, non-finite, or negative. D1 can
// return an INTEGER column as a numeric string, so a bare `?? null` pass-through
// would silently leak the string into the API payload and break downstream
// arithmetic/comparisons. Mirrors the `toBlockNumber` already applied in
// account-events.mjs / chain-analytics.mjs and the `toBlockNumber` added to
// blocks.mjs in #2435.
function toChainPosition(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

// Coerce a TAO amount cell (fee_tao / tip_tao, D1 REAL columns) to a number
// rounded to rao precision (9 dp), or null when missing/non-finite. D1 can
// return a REAL column as a numeric string, so a bare `?? null` pass-through
// would leak the string form into the ["number","null"] contract field and
// serve unrounded float noise. Mirrors toTaoOrNull in account-events.mjs
// (#2662) and the coercion in formatRegistration (#2487).
function toTaoOrNull(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 1e9) / 1e9 : null;
}

// Keep only well-formed extrinsics rows (a valid (block_number, extrinsic_index)
// primary key + an integer timestamp). Shared by the staged-batch loader so
// garbage is rejected before it touches D1.
export function validExtrinsicRows(rows) {
  return Array.isArray(rows)
    ? rows.filter(
        (r) =>
          Number.isInteger(r?.block_number) &&
          r.block_number >= 0 &&
          Number.isInteger(r?.extrinsic_index) &&
          r.extrinsic_index >= 0 &&
          Number.isInteger(r?.observed_at),
      )
    : [];
}

// Build parameterized INSERT OR IGNORE statements for extrinsics rows, chunked
// under D1's 100-bound-param limit (11 cols x 9 = 99). Idempotent on
// (block_number, extrinsic_index) (the primary key). Values are ALWAYS bound,
// never interpolated — a tampered payload can only fail, never inject. Mirrors
// blockInsertStatements (#1345).
export function extrinsicInsertStatements(db, rows) {
  const cols = EXTRINSIC_INSERT_COLUMNS;
  const colList = cols.join(",");
  const ROWS_PER_STMT = 9;
  const statements = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_STMT) {
    const chunk = rows.slice(i, i + ROWS_PER_STMT);
    const tuples = chunk
      .map(() => `(${cols.map(() => "?").join(",")})`)
      .join(",");
    const values = chunk.flatMap((row) => cols.map((c) => row[c] ?? null));
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO extrinsics (${colList}) VALUES ${tuples}`,
        )
        .bind(...values),
    );
  }
  return statements;
}

// Hourly maintenance: prune raw extrinsics older than the retention window so the
// hot table stays lean. Mirrors pruneBlocks (#1345) — no-ops on a cold/absent
// store, returns pruned:false (never throws) so a failure here cannot break the
// shared maintenance cron.
export async function pruneExtrinsics(env, overrides = {}) {
  const now = overrides.now || (() => Date.now());
  const db = overrides.db || env.METAGRAPH_HEALTH_DB;
  if (!db?.prepare) return { pruned: false };
  const cutoff = now() - (overrides.retentionMs || EXTRINSIC_RETENTION_MS);
  try {
    const result = await db
      .prepare(`DELETE FROM extrinsics WHERE observed_at < ?`)
      .bind(cutoff)
      .run();
    return { pruned: true, cutoff, changes: result?.meta?.changes ?? null };
  } catch {
    return { pruned: false };
  }
}

// ---- Extrinsic API builders ------------------------------------------------
// The columns the extrinsic handlers SELECT for an extrinsic row.
export const EXTRINSIC_READ_COLUMNS =
  "block_number, extrinsic_index, extrinsic_hash, signer, call_module, call_function, call_args, success, fee_tao, tip_tao, observed_at";

// One D1 extrinsics row → a clean API extrinsic object. Null-safe on junk/sparse
// rows. success is normalized to a boolean (null when undeterminable).
export function formatExtrinsic(row) {
  if (!row || typeof row !== "object") return null;
  let call_args = null;
  if (row.call_args != null) {
    try {
      call_args = JSON.parse(row.call_args);
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

// Per-extrinsic detail artifact. `extrinsic` is null when the ref didn't resolve
// (cold store or unknown extrinsic) — schema-stable, never throws (mirrors the
// block detail route's `block:null`). `events` are the indexed account_events this
// extrinsic emitted (#1849), already formatted + bounded by the handler; defaults
// to [] (empty for pre-migration rows, non-ApplyExtrinsic events, or a cold store).
export function buildExtrinsic(row, ref, events = []) {
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
export function buildExtrinsicFeed(rows, { limit, offset, nextCursor } = {}) {
  const extrinsics = (rows || []).map(formatExtrinsic).filter(Boolean);
  return {
    schema_version: 1,
    extrinsic_count: extrinsics.length,
    limit: limit ?? null,
    offset: offset ?? null,
    next_cursor: nextCursor ?? null,
    extrinsics,
  };
}

// Per-account signed-extrinsic feed artifact (#1844, newest first). The account's
// extrinsics are matched by the extrinsic SIGNER only, NOT the hotkey or coldkey
// union the account_events routes use — `extrinsics` carries a single `signer`
// column. extrinsic_count is the PAGE count (matches the feed + account-events
// convention), not a grand total. Null-safe on a cold store.
export function buildAccountExtrinsics(
  rows,
  ss58,
  { limit, offset, nextCursor } = {},
) {
  const extrinsics = (rows || []).map(formatExtrinsic).filter(Boolean);
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

// Per-block extrinsics sub-resource artifact (#1845): the extrinsics in one block,
// in natural read order (extrinsic_index ASC) — note this differs from the global
// feed's newest-first DESC; both are covered by the (block_number, extrinsic_index)
// PK. block_number is null + extrinsics:[] when the ref didn't resolve (cold store
// or unknown block) — schema-stable, never throws.
export function buildBlockExtrinsics(
  rows,
  ref,
  blockNumber,
  { limit, offset } = {},
) {
  const extrinsics = (rows || []).map(formatExtrinsic).filter(Boolean);
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

// Filtered extrinsic feed (newest first) with keyset cursor support (#1851).
// Supported filters mirror GET /api/v1/extrinsics (#1846): signer, callModule,
// callFunction, block, blockStart/blockEnd, from/to (observed_at epoch-ms), and
// success (true|false only; omit for no filter). A cursor takes precedence over
// offset when present — uses a (block_number, extrinsic_index) row-value seek.
export async function loadExtrinsics(
  d1,
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
    limit,
    offset,
    cursor,
    nowMs = Date.now(),
  } = {},
) {
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
  const conds = [];
  const params = [];
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
  if (useCursor) {
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
    ? encodeCursor([last.block_number, last.extrinsic_index])
    : null;
  return buildExtrinsicFeed(rows, { limit: lim, offset: off, nextCursor });
}

// A canonical composite ref is EXACTLY two strict decimal halves — so a loose
// split("-") + Number() can't coerce a malformed ref (hex, sci-notation, an
// extra/empty segment, leading space, oversized digits) into a wrong-but-valid
// lookup. Mirrors the REST route's COMPOSITE_REF_RE + isSafeInteger guard
// (#2063/#2241); this shared MCP get_extrinsic loader was the missed sibling.
// Kept local because src/ is a leaf and must not import the worker request handler.
const COMPOSITE_REF_RE = /^(\d+)-(\d+)$/;

// Per-extrinsic detail by 0x hash or composite "block_number-extrinsic_index"
// ref. Returns extrinsic:null when the ref is unknown or the store is cold —
// never throws (schema-stable zero, mirrors the REST route). Events emitted by
// the extrinsic are NOT embedded here; use get_account_events filtered by block.
export async function loadExtrinsic(d1, ref) {
  const isHash = /^0x[0-9a-fA-F]{64}$/.test(String(ref));
  let rows;
  if (isHash) {
    // The poller stores hashes lowercase and D1 TEXT columns are BINARY-collated,
    // so a mixed/upper-case 0x ref would miss. Lowercase the hash before binding —
    // parity with the REST handleExtrinsic route (#1955); this shared MCP
    // get_extrinsic loader was the missed sibling (the composite-ref guard #2316
    // left it case-naive).
    rows = await d1(
      `SELECT ${EXTRINSIC_READ_COLUMNS} FROM extrinsics WHERE extrinsic_hash = ? ORDER BY block_number DESC, extrinsic_index DESC LIMIT 1`,
      [String(ref).toLowerCase()],
    );
  } else {
    const composite = COMPOSITE_REF_RE.exec(String(ref));
    const blockNumber = composite ? Number(composite[1]) : NaN;
    const extrinsicIndex = composite ? Number(composite[2]) : NaN;
    rows =
      composite &&
      Number.isSafeInteger(blockNumber) &&
      Number.isSafeInteger(extrinsicIndex)
        ? await d1(
            `SELECT ${EXTRINSIC_READ_COLUMNS} FROM extrinsics WHERE block_number = ? AND extrinsic_index = ? LIMIT 1`,
            [blockNumber, extrinsicIndex],
          )
        : [];
  }
  return buildExtrinsic(rows[0], ref);
}
