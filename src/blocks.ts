// Block explorer (#1345 epic, first vertical slice): the D1 `blocks` tier —
// first-party per-block headers decoded DIRECTLY from finney by the same
// chain-direct poller (scripts/fetch-events.py) that fills account_events, NOT
// Taostats. This module holds the load contract, the row→API shaping, and the
// retention prune. Pure + exported for tests; the Worker runs the D1 I/O.
import {
  BLOCK_PAGINATION,
  clampLimit,
  clampOffset,
} from "../workers/request-params.ts";
import { decodeCursor, encodeCursor } from "./cursor.ts";

type D1Runner = (
  sql: string,
  params: unknown[],
) => Promise<Array<Record<string, unknown>>>;

function toIso(ms: unknown): string | null {
  if (ms == null) return null;
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

// Coerce a block-height cell to a non-negative integer, or null when missing,
// non-finite, or negative. D1 can return an INTEGER column as a numeric string,
// so a bare `row.block_number ?? null` would silently leak the string into the
// API payload (and break downstream arithmetic/comparisons). Mirrors the
// `toBlockNumber` already applied in account-events.mjs / chain-analytics.ts
// and the `nullableInteger` coercion added to counterparties in #2414.
function toBlockNumber(value: unknown): number | null {
  if (value == null) return null;
  // Blank D1 cells coerce via Number("") → 0; trim rejects "" / whitespace-only.
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

// Coerce a decoded-author cell to a non-empty string or null. Postgres's
// backfilled blocks for spec_versions 419/421/422 (#4687 -- an indexer-rs
// Aura-authority-digest decode gap for those three historical runtime
// versions, not a live-ingestion defect) have `author = ""` instead of the
// SS58 string D1 has for the same rows. A bare `row.author ?? null` only
// catches null/undefined, so it was serving the empty string as if it were
// a decoded value -- present-looking but wrong, worse than an honest null.
function toAuthorOrNull(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  return value as string;
}

// ---- Block API builders ----------------------------------------------------
// The columns the block handlers SELECT for a block row.
export const BLOCK_READ_COLUMNS =
  "block_number, block_hash, parent_hash, author, extrinsic_count, event_count, spec_version, observed_at";

export interface BlockApi {
  block_number: number | null;
  block_hash: unknown;
  parent_hash: unknown;
  author: string | null;
  extrinsic_count: number | null;
  event_count: number | null;
  spec_version: number | null;
  observed_at: string | null;
}

// One D1 blocks row → a clean API block object. Null-safe on junk/sparse rows.
export function formatBlock(
  row: Record<string, unknown> | null | undefined,
): BlockApi | null {
  if (!row || typeof row !== "object") return null;
  return {
    block_number: toBlockNumber(row.block_number),
    block_hash: row.block_hash ?? null,
    parent_hash: row.parent_hash ?? null,
    author: toAuthorOrNull(row.author),
    // extrinsic_count / event_count / spec_version (D1 INTEGER columns) — coerce
    // through toBlockNumber like block_number above, so a numeric string never
    // leaks the string form into these ["integer","null"] contract fields.
    // Mirrors the count coercion in account-events.mjs and the fix in #2435.
    extrinsic_count: toBlockNumber(row.extrinsic_count),
    event_count: toBlockNumber(row.event_count),
    spec_version: toBlockNumber(row.spec_version),
    observed_at: toIso(row.observed_at),
  };
}

export interface BlockDetail {
  schema_version: 1;
  ref: unknown;
  block: BlockApi | null;
  prev_block_number: number | null;
  next_block_number: number | null;
}

// Per-block detail artifact. `block` is null when the ref didn't resolve (cold
// store or unknown block) — schema-stable, never throws (mirrors the neuron
// detail route's `neuron:null`). prev/next_block_number (#1853) are the nearest
// STORED neighbors for chain-walk nav (the handler computes them, skipping pruned
// gaps); both null when the block is null or at a window edge. parent_hash (on the
// block object) already provides the backward hash edge.
export function buildBlock(
  row: Record<string, unknown> | null | undefined,
  ref: unknown,
  { prev, next }: { prev?: unknown; next?: unknown } = {},
): BlockDetail {
  const block = formatBlock(row);
  return {
    schema_version: 1,
    ref: ref ?? null,
    block,
    // D1 can return INTEGER neighbor heights as numeric strings; coerce like
    // formatBlock's block_number so chain-walk nav never leaks string cells.
    prev_block_number: block ? toBlockNumber(prev) : null,
    next_block_number: block ? toBlockNumber(next) : null,
  };
}

export interface BlockFeed {
  schema_version: 1;
  block_count: number;
  limit: number | null;
  offset: number | null;
  next_cursor: string | null;
  blocks: BlockApi[];
}

// Recent-block feed artifact (newest first). Null-safe on a cold/absent store
// (returns a schema-stable zero). next_cursor (#1851) is the opaque keyset token
// for the next page, or null at end-of-window; the caller computes it.
export function buildBlockFeed(
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
): BlockFeed {
  const blocks = (rows || [])
    .map(formatBlock)
    .filter((block): block is BlockApi => Boolean(block));
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

// Astronomically high per-block count floors are deterministic no-match cases.
// Short-circuit them before D1 so public callers cannot amplify cost by forcing
// scans to prove an impossible empty result (mirrors handleBlocks / #1991).
export const MAX_BLOCK_COUNT_FILTER = 1_000_000;

export interface LoadBlocksOptions {
  limit?: string | number | null;
  offset?: string | number | null;
  cursor?: unknown;
  author?: string | null;
  specVersion?: number | null;
  blockStart?: number | null;
  blockEnd?: number | null;
  from?: number | null;
  to?: number | null;
  minExtrinsics?: number | null;
  minEvents?: number | null;
}

// Recent-block feed (newest first) with keyset cursor support (#1851). A cursor
// takes precedence over offset when present (WHERE block_number < ?). Optional
// conjunctive filters mirror GET /api/v1/blocks (#1846/#1991): author,
// spec_version, block_start/block_end, from/to (observed_at epoch-ms), and
// min_extrinsics/min_events floors. Inverted indexed ranges short-circuit to an
// empty feed without querying D1.
export async function loadBlocks(
  d1: D1Runner,
  {
    limit,
    offset,
    cursor,
    author,
    specVersion,
    blockStart,
    blockEnd,
    from,
    to,
    minExtrinsics,
    minEvents,
  }: LoadBlocksOptions = {},
): Promise<BlockFeed> {
  const lim = clampLimit(limit, BLOCK_PAGINATION);
  const off = clampOffset(offset);
  if (
    (blockStart != null && blockEnd != null && blockStart > blockEnd) ||
    (from != null && to != null && from > to) ||
    (minExtrinsics != null && minExtrinsics > MAX_BLOCK_COUNT_FILTER) ||
    (minEvents != null && minEvents > MAX_BLOCK_COUNT_FILTER)
  ) {
    return buildBlockFeed([], { limit: lim, offset: off, nextCursor: null });
  }
  const conds: string[] = [];
  const params: unknown[] = [];
  if (author) {
    conds.push("author = ?");
    params.push(author);
  }
  if (specVersion != null) {
    conds.push("spec_version = ?");
    params.push(specVersion);
  }
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
  if (minExtrinsics != null) {
    conds.push("extrinsic_count >= ?");
    params.push(minExtrinsics);
  }
  if (minEvents != null) {
    conds.push("event_count >= ?");
    params.push(minEvents);
  }
  const cur = decodeCursor(cursor, 1);
  const useCursor = Boolean(cur);
  if (useCursor && cur) {
    conds.push("block_number < ?");
    params.push(cur[0]);
  }
  let sql = `SELECT ${BLOCK_READ_COLUMNS} FROM blocks`;
  if (conds.length) sql += ` WHERE ${conds.join(" AND ")}`;
  sql += " ORDER BY block_number DESC LIMIT ?";
  params.push(lim);
  if (!useCursor) {
    sql += " OFFSET ?";
    params.push(off);
  }
  const rows = await d1(sql, params);
  const last = rows.length === lim ? rows[rows.length - 1] : null;
  const nextCursor = last ? encodeCursor([last.block_number as number]) : null;
  return buildBlockFeed(rows, { limit: lim, offset: off, nextCursor });
}

// A strict non-negative block_number, or null for a non-decimal ref — so a
// malformed ref (0x-short, 1e3, signs, leading space, oversized digits) is a
// clean miss rather than a Number()-coerced wrong-but-valid lookup. Mirrors the
// REST route's strictBlockNumber guard (#2063/#2241); this shared MCP get_block
// loader was the missed sibling. Kept local because src/ is a leaf and must not
// import the worker request handler.
function strictBlockNumber(ref: unknown): number | null {
  if (!/^\d+$/.test(String(ref))) return null;
  const value = Number(ref);
  return Number.isSafeInteger(value) ? value : null;
}

// Per-block detail by numeric block_number or 0x block_hash. Includes nearest
// stored neighbors (prev_block_number, next_block_number) for chain-walk nav
// (#1853). Returns block:null when the ref is unknown or the store is cold —
// never throws (schema-stable zero, mirrors the REST route).
export async function loadBlock(
  d1: D1Runner,
  ref: unknown,
): Promise<BlockDetail> {
  const isHash = /^0x[0-9a-fA-F]{64}$/.test(String(ref));
  const blockNumber = isHash ? null : strictBlockNumber(ref);
  // A non-hash ref that isn't a strict, safe-integer block_number can never match
  // a stored row — skip the lookup and serve the schema-stable miss.
  if (!isHash && blockNumber === null) {
    return buildBlock(undefined, ref);
  }
  const sql = isHash
    ? `SELECT ${BLOCK_READ_COLUMNS} FROM blocks WHERE block_hash = ? LIMIT 1`
    : `SELECT ${BLOCK_READ_COLUMNS} FROM blocks WHERE block_number = ? LIMIT 1`;
  // The poller stores hashes lowercase and D1 TEXT columns are BINARY-collated,
  // so a mixed/upper-case 0x ref would miss. Lowercase the hash before binding —
  // parity with the REST handleBlock route (#1955); this shared MCP get_block
  // loader was the missed sibling (the strict-ref guard #2314 left it case-naive).
  const param = isHash ? String(ref).toLowerCase() : blockNumber;
  const rows = await d1(sql, [param]);
  let prev: unknown = null;
  let next: unknown = null;
  // Coerce the resolved anchor through the same helper formatBlock uses: D1 can
  // return the INTEGER block_number as a numeric string, and a bare
  // `Number.isInteger(rows[0]?.block_number)` guard is false for "1234", so the
  // neighbor query would be skipped and a resolved block would wrongly report
  // prev/next_block_number: null (breaking chain-walk nav #1853). Mirrors the
  // string-cell coercion in formatBlock / account-events formatAccountDay (#2489).
  const resolvedNumber = toBlockNumber(rows[0]?.block_number);
  if (resolvedNumber !== null) {
    const nbr = await d1(
      `SELECT (SELECT MAX(block_number) FROM blocks WHERE block_number < ?) AS prev, (SELECT MIN(block_number) FROM blocks WHERE block_number > ?) AS next`,
      [resolvedNumber, resolvedNumber],
    );
    prev = nbr[0]?.prev ?? null;
    next = nbr[0]?.next ?? null;
  }
  return buildBlock(rows[0], ref, { prev, next });
}
