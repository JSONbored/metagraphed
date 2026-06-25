// Block explorer (#1345 epic, second vertical slice): the D1 `extrinsics` tier —
// first-party per-extrinsic (transaction) records decoded DIRECTLY from finney by
// the same chain-direct poller (scripts/fetch-events.py) that fills account_events
// + blocks, NOT Taostats. This module holds the load contract, the row→API
// shaping, and the retention prune. Pure + exported for tests; the Worker runs
// the D1 I/O.

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
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
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
    block_number: row.block_number ?? null,
    extrinsic_index: row.extrinsic_index ?? null,
    extrinsic_hash: row.extrinsic_hash ?? null,
    signer: row.signer ?? null,
    call_module: row.call_module ?? null,
    call_function: row.call_function ?? null,
    call_args,
    success: row.success == null ? null : row.success === 1,
    fee_tao: row.fee_tao ?? null,
    tip_tao: row.tip_tao ?? null,
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
export function buildAccountExtrinsics(rows, ss58, { limit, offset } = {}) {
  const extrinsics = (rows || []).map(formatExtrinsic).filter(Boolean);
  return {
    schema_version: 1,
    ss58,
    extrinsic_count: extrinsics.length,
    limit: limit ?? null,
    offset: offset ?? null,
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
