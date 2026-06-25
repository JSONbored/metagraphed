// Block explorer (#1345 epic, second vertical slice): the D1 `extrinsics` tier —
// first-party per-extrinsic (transaction) records decoded DIRECTLY from finney by
// the same chain-direct poller (scripts/fetch-events.py) that fills account_events
// + blocks, NOT Taostats. This module holds the load contract, the row→API
// shaping, and the (currently inactive) retention prune. Pure + exported for
// tests; the Worker runs the D1 I/O.

// Retention constant kept for tests. pruneExtrinsics is NOT called by the cron —
// the block explorer requires full historical depth (ADR 0012); prune is deferred
// to the Postgres migration (#1519).
export const EXTRINSIC_RETENTION_MS = 90 * 24 * 60 * 60 * 1000; // reference only

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
  "fee_tao",
  "success",
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
// under D1's 100-bound-param limit (10 cols x 9 = 90). Idempotent on
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
  "block_number, extrinsic_index, extrinsic_hash, signer, call_module, call_function, call_args, fee_tao, success, observed_at";

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
    fee_tao: row.fee_tao ?? null,
    success: row.success == null ? null : row.success === 1,
    observed_at: toIso(row.observed_at),
  };
}

// Per-extrinsic detail artifact. `extrinsic` is null when the ref didn't resolve
// (cold store or unknown extrinsic) — schema-stable, never throws (mirrors the
// block detail route's `block:null`).
export function buildExtrinsic(row, ref) {
  return {
    schema_version: 1,
    ref: ref ?? null,
    extrinsic: formatExtrinsic(row),
  };
}

// Recent-extrinsic feed artifact (newest first). Null-safe on a cold/absent store
// (returns a schema-stable zero).
export function buildExtrinsicFeed(rows, { limit, offset } = {}) {
  const extrinsics = (rows || []).map(formatExtrinsic).filter(Boolean);
  return {
    schema_version: 1,
    extrinsic_count: extrinsics.length,
    limit: limit ?? null,
    offset: offset ?? null,
    extrinsics,
  };
}
