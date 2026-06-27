// Block explorer (#1345 epic, first vertical slice): the D1 `blocks` tier —
// first-party per-block headers decoded DIRECTLY from finney by the same
// chain-direct poller (scripts/fetch-events.py) that fills account_events, NOT
// Taostats. This module holds the load contract, the row→API shaping, and the
// retention prune. Pure + exported for tests; the Worker runs the D1 I/O.
import { clampInt } from "../workers/config.mjs";
import { decodeCursor, encodeCursor } from "./cursor.mjs";

// D1 safety-valve: 365-day retention prevents unbounded growth before the
// Postgres cold tier (#1519) ships. pruneBlocks runs in the HEALTH_PRUNE_CRON.
export const BLOCK_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

// Columns written to blocks — THE load contract. scripts/fetch-events.py emits
// rows with exactly these keys; loadStagedBlocks binds them in this order. Values
// are always bound, never interpolated into SQL.
export const BLOCK_INSERT_COLUMNS = [
  "block_number",
  "block_hash",
  "parent_hash",
  "author",
  "extrinsic_count",
  "event_count",
  "spec_version",
  "observed_at",
];

function toIso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// Keep only well-formed blocks rows (a valid block_number primary key + a
// non-empty hash + an integer timestamp). Shared by the staged-batch loader so
// garbage is rejected before it touches D1.
export function validBlockRows(rows) {
  return Array.isArray(rows)
    ? rows.filter(
        (r) =>
          Number.isInteger(r?.block_number) &&
          r.block_number >= 0 &&
          typeof r?.block_hash === "string" &&
          r.block_hash.length > 0 &&
          Number.isInteger(r?.observed_at),
      )
    : [];
}

// Build parameterized INSERT OR IGNORE statements for blocks rows, chunked under
// D1's 100-bound-param limit (8 cols x 12 = 96). Idempotent on block_number (the
// primary key). Values are ALWAYS bound, never interpolated — a tampered payload
// can only fail, never inject. Mirrors eventInsertStatements (#1346).
export function blockInsertStatements(db, rows) {
  const cols = BLOCK_INSERT_COLUMNS;
  const colList = cols.join(",");
  const ROWS_PER_STMT = 12;
  const statements = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_STMT) {
    const chunk = rows.slice(i, i + ROWS_PER_STMT);
    const tuples = chunk
      .map(() => `(${cols.map(() => "?").join(",")})`)
      .join(",");
    const values = chunk.flatMap((row) => cols.map((c) => row[c] ?? null));
    statements.push(
      db
        .prepare(`INSERT OR IGNORE INTO blocks (${colList}) VALUES ${tuples}`)
        .bind(...values),
    );
  }
  return statements;
}

// Hourly maintenance: prune raw blocks older than the retention window so the hot
// table stays lean. Mirrors pruneAccountEvents (#1346) — no-ops on a cold/absent
// store, returns pruned:false (never throws) so a failure here cannot break the
// shared maintenance cron.
export async function pruneBlocks(env, overrides = {}) {
  const now = overrides.now || (() => Date.now());
  const db = overrides.db || env.METAGRAPH_HEALTH_DB;
  if (!db?.prepare) return { pruned: false };
  const cutoff = now() - (overrides.retentionMs || BLOCK_RETENTION_MS);
  try {
    const result = await db
      .prepare(`DELETE FROM blocks WHERE observed_at < ?`)
      .bind(cutoff)
      .run();
    return { pruned: true, cutoff, changes: result?.meta?.changes ?? null };
  } catch {
    return { pruned: false };
  }
}

// ---- Block API builders ----------------------------------------------------
// The columns the block handlers SELECT for a block row.
export const BLOCK_READ_COLUMNS =
  "block_number, block_hash, parent_hash, author, extrinsic_count, event_count, spec_version, observed_at";

// One D1 blocks row → a clean API block object. Null-safe on junk/sparse rows.
export function formatBlock(row) {
  if (!row || typeof row !== "object") return null;
  return {
    block_number: row.block_number ?? null,
    block_hash: row.block_hash ?? null,
    parent_hash: row.parent_hash ?? null,
    author: row.author ?? null,
    extrinsic_count: row.extrinsic_count ?? null,
    event_count: row.event_count ?? null,
    spec_version: row.spec_version ?? null,
    observed_at: toIso(row.observed_at),
  };
}

// Per-block detail artifact. `block` is null when the ref didn't resolve (cold
// store or unknown block) — schema-stable, never throws (mirrors the neuron
// detail route's `neuron:null`). prev/next_block_number (#1853) are the nearest
// STORED neighbors for chain-walk nav (the handler computes them, skipping pruned
// gaps); both null when the block is null or at a window edge. parent_hash (on the
// block object) already provides the backward hash edge.
export function buildBlock(row, ref, { prev, next } = {}) {
  const block = formatBlock(row);
  return {
    schema_version: 1,
    ref: ref ?? null,
    block,
    prev_block_number: block ? (prev ?? null) : null,
    next_block_number: block ? (next ?? null) : null,
  };
}

// Recent-block feed artifact (newest first). Null-safe on a cold/absent store
// (returns a schema-stable zero). next_cursor (#1851) is the opaque keyset token
// for the next page, or null at end-of-window; the caller computes it.
export function buildBlockFeed(rows, { limit, offset, nextCursor } = {}) {
  const blocks = (rows || []).map(formatBlock).filter(Boolean);
  return {
    schema_version: 1,
    block_count: blocks.length,
    limit: limit ?? null,
    offset: offset ?? null,
    next_cursor: nextCursor ?? null,
    blocks,
  };
}

// ---- Block D1 read paths ---------------------------------------------------
// One source of truth for the block SQL + pagination, shared by the REST
// handlers and the MCP block-explorer tools. `d1` is a
// (sql, params) => Promise<rows[]> runner; a cold/unbound DB yields [].

// Recent-block feed (newest first) with keyset cursor support (#1851). A cursor
// takes precedence over offset when present (WHERE block_number < ?).
export async function loadBlocks(d1, { limit, offset, cursor } = {}) {
  const lim = clampInt(limit, 50, 1, 100);
  const off = clampInt(offset, 0, 0, 1_000_000);
  const cur = decodeCursor(cursor, 1);
  let rows;
  if (cur) {
    rows = await d1(
      `SELECT ${BLOCK_READ_COLUMNS} FROM blocks WHERE block_number < ? ORDER BY block_number DESC LIMIT ?`,
      [cur[0], lim],
    );
  } else {
    rows = await d1(
      `SELECT ${BLOCK_READ_COLUMNS} FROM blocks ORDER BY block_number DESC LIMIT ? OFFSET ?`,
      [lim, off],
    );
  }
  const last = rows.length === lim ? rows[rows.length - 1] : null;
  const nextCursor = last ? encodeCursor([last.block_number]) : null;
  return buildBlockFeed(rows, { limit: lim, offset: off, nextCursor });
}

// Per-block detail by numeric block_number or 0x block_hash. Includes nearest
// stored neighbors (prev_block_number, next_block_number) for chain-walk nav
// (#1853). Returns block:null when the ref is unknown or the store is cold —
// never throws (schema-stable zero, mirrors the REST route).
export async function loadBlock(d1, ref) {
  const isHash = /^0x[0-9a-fA-F]{64}$/.test(String(ref));
  const sql = isHash
    ? `SELECT ${BLOCK_READ_COLUMNS} FROM blocks WHERE block_hash = ? LIMIT 1`
    : `SELECT ${BLOCK_READ_COLUMNS} FROM blocks WHERE block_number = ? LIMIT 1`;
  const param = isHash ? String(ref) : Number(ref);
  const rows = await d1(sql, [param]);
  let prev = null;
  let next = null;
  const resolvedNumber = rows[0]?.block_number;
  if (Number.isInteger(resolvedNumber)) {
    const nbr = await d1(
      `SELECT (SELECT MAX(block_number) FROM blocks WHERE block_number < ?) AS prev, (SELECT MIN(block_number) FROM blocks WHERE block_number > ?) AS next`,
      [resolvedNumber, resolvedNumber],
    );
    prev = nbr[0]?.prev ?? null;
    next = nbr[0]?.next ?? null;
  }
  return buildBlock(rows[0], ref, { prev, next });
}
