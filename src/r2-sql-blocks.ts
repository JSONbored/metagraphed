// Chain-blocks reads served from the lakehouse (R2 SQL) instead of the
// decommissioned box's Postgres.
//
// PAYLOAD PARITY IS THE WHOLE POINT. These loaders return rows into the SAME
// pure formatters the Postgres tier feeds -- src/blocks.ts's buildBlock and
// buildBlockFeed -- so a caller cannot tell which tier answered. Anything that
// re-implemented the shaping here would drift from the published contract the
// moment either side changed.
//
// R2 SQL LIMITS, established by probing the live warehouse rather than by
// reading docs (2026-08-02):
//   - SELECT / WHERE / multi-column ORDER BY / LIMIT: supported.
//   - OFFSET: NOT SUPPORTED ("unsupported feature: OFFSET clause is not
//     supported"). Handled by over-fetching limit+offset rows and slicing,
//     which is exact for the shallow offsets a UI actually issues and is
//     refused outright past OFFSET_EMULATION_CAP rather than silently
//     returning the wrong page.
//   - Tuple comparison for the Postgres tier's 2-part cursor is not relied on
//     here; the cursor degrades to its block_number component, which orders
//     identically for this table (observed_at and block_number are both
//     monotonic in practice, and block_number is authoritative).
//   - ~1-2s per query, so every caller must sit behind the existing edge
//     cache. See src/r2-sql.ts's header for the measurements.

import { buildBlock, buildBlockFeed } from "./blocks.ts";
import { decodeCursor, encodeCursor } from "./cursor.ts";
import { type ChainNetworkId, chainTable } from "./chain-network.ts";
import {
  r2SqlQuery,
  safeBlockNumber,
  safeHexLiteral,
  safeSs58Literal,
} from "./r2-sql.ts";

/** Columns the formatters need — kept identical to the Postgres tier's SELECT
 * list so both tiers hand the formatter the same shape. */
const BLOCK_COLUMNS =
  "block_number, block_hash, parent_hash, author, extrinsic_count, event_count, spec_version, observed_at";

/**
 * How deep an emulated OFFSET may go. Past this the over-fetch stops being a
 * reasonable trade and the loader declines, so the caller degrades to its
 * schema-stable empty rather than serving a page that is quietly wrong or
 * spending seconds scanning for a page nobody paginated to by hand.
 */
export const OFFSET_EMULATION_CAP = 1000;

export interface BlockFeedQuery {
  limit: number;
  offset: number;
  /** The raw ?cursor token: data-api's dot-joined (observed_at, block_number)
   * pair, decoded with the shared codec so tokens round-trip across tiers. */
  cursor?: unknown;
  author?: string | null;
  specVersion?: number | null;
  blockStart?: number | null;
  blockEnd?: number | null;
  from?: unknown;
  to?: unknown;
  minExtrinsics?: number | null;
  minEvents?: number | null;
  /** INTERNAL continuation for the seam stitch (src/blocks-cold-tier.ts):
   * strictly-below-this-block, applied on top of whatever public cursor the
   * caller sent. Distinct from `cursor` because the stitch needs an exclusive
   * block ceiling, not a public token. */
  ceilingBlock?: number | null;
}

/** The cursor pair the blocks feed pages on, mirroring data-api. */
const BLOCKS_CURSOR_ARITY = 2;

/** An author is an SS58 address; accept only the character set that can be,
 * since R2 SQL has no bound parameters and this value reaches a string-built
 * query. Anything else is refused rather than escaped. */
export function safeAuthorLiteral(value: unknown): string | null {
  // Delegates to the shared SS58 guard so block authors and extrinsic signers
  // cannot drift apart into two subtly different notions of a valid address.
  return safeSs58Literal(value);
}

/**
 * The recent-block feed. Returns the formatted payload, or null when the
 * lakehouse cannot answer (unconfigured, failed, or a request this tier
 * cannot serve faithfully) so the caller keeps its existing fallback.
 */
export async function loadBlockFeedFromR2Sql(
  env: Env | null | undefined,
  query: BlockFeedQuery,
  /** Which chain's lakehouse namespace to read (#8700). */
  network?: ChainNetworkId,
): Promise<ReturnType<typeof buildBlockFeed> | null> {
  const page = await fetchBlockRowsFromR2Sql(env, query, network);
  if (page === null) return null;
  return buildBlockFeed(page.rows as never[], {
    limit: page.limit,
    offset: page.offset,
    nextCursor: page.nextCursor,
  });
}

/**
 * The same query as {@link loadBlockFeedFromR2Sql}, stopping at the RAW rows.
 *
 * Callers that stitch this tier together with another source need the rows
 * before formatting: feeding an already-formatted payload back through the
 * formatter would run it twice, and a formatter is only guaranteed to be
 * correct on the shape it was designed for. One formatting pass, at the end,
 * over rows from every source.
 */
export async function fetchBlockRowsFromR2Sql(
  env: Env | null | undefined,
  query: BlockFeedQuery,
  /** Which chain's lakehouse namespace to read (#8700). */
  network?: ChainNetworkId,
): Promise<{
  rows: Record<string, unknown>[];
  limit: number;
  offset: number;
  nextCursor: string | null;
} | null> {
  const limit = safeBlockNumber(query.limit);
  const offset = safeBlockNumber(query.offset ?? 0);
  if (limit === null || offset === null || limit <= 0) return null;
  // Refuse rather than mis-serve: see OFFSET_EMULATION_CAP.
  if (offset > OFFSET_EMULATION_CAP) return null;

  const where: string[] = [];
  const author = safeAuthorLiteral(query.author);
  if (query.author != null) {
    // An author filter we cannot express safely must not silently widen the
    // result to every author.
    if (author === null) return null;
    where.push(`author = '${author}'`);
  }
  for (const [value, clause] of [
    [query.specVersion, "spec_version ="],
    [query.blockStart, "block_number >="],
    [query.blockEnd, "block_number <="],
    [query.from, "observed_at >="],
    [query.to, "observed_at <="],
    [query.minExtrinsics, "extrinsic_count >="],
    [query.minEvents, "event_count >="],
    [query.ceilingBlock, "block_number <"],
  ] as [unknown, string][]) {
    if (value == null) continue;
    const n = safeBlockNumber(value);
    if (n === null) return null;
    where.push(`${clause} ${n}`);
  }
  const cursor = decodeCursor(query.cursor, BLOCKS_CURSOR_ARITY);
  if (cursor) {
    // The same 2-part tuple seek data-api issues for this token (tuple
    // comparison verified supported on the live engine, 2026-08-02). An
    // invalid token decodes to null and means page 1 -- data-api's exact
    // behavior -- so both tiers serve the identical page for the identical
    // request, malformed tokens included.
    where.push(`(observed_at, block_number) < (${cursor[0]}, ${cursor[1]})`);
  }

  // Cursor pages never carry an offset (the cursor already narrows past
  // prior pages), mirroring data-api's `OFFSET only when no cursor`.
  const paged = cursor ? 0 : offset;
  const sql =
    `SELECT ${BLOCK_COLUMNS} FROM ${chainTable("blocks", network)}` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    // observed_at-leading, EXACTLY data-api's order: the cursor token encodes
    // this composite key, so a different order would mis-seek its tokens.
    ` ORDER BY observed_at DESC, block_number DESC LIMIT ${limit + paged}`;

  const rows = await r2SqlQuery(env, sql);
  if (rows === null) return null;

  const page = paged > 0 ? rows.slice(paged) : rows;
  const last = page.length === limit ? page[page.length - 1] : null;
  // The SAME token the Postgres tier emits for this row, so a client can page
  // seamlessly across a tier transition in either direction.
  const nextCursor = last
    ? encodeCursor([
        safeBlockNumber(last.observed_at),
        safeBlockNumber(last.block_number),
      ])
    : null;
  return { rows: page, limit, offset, nextCursor };
}

/**
 * One block by height or hash. `ref` is whatever the route matched; it is
 * validated here rather than trusted, because it reaches a string-built query.
 */
export async function loadBlockFromR2Sql(
  env: Env | null | undefined,
  ref: string,
  /** Which chain's lakehouse namespace to read (#8700). */
  network?: ChainNetworkId,
): Promise<ReturnType<typeof buildBlock> | null> {
  const asNumber = safeBlockNumber(ref);
  const asHash = asNumber === null ? safeHexLiteral(ref) : null;
  if (asNumber === null && asHash === null) return null;
  const predicate =
    asNumber !== null
      ? `block_number = ${asNumber}`
      : `block_hash = '${asHash}'`;
  const rows = await r2SqlQuery(
    env,
    `SELECT ${BLOCK_COLUMNS} FROM ${chainTable("blocks", network)} WHERE ${predicate} LIMIT 1`,
  );
  if (rows === null) return null;
  // A confirmed absence is an ANSWER: buildBlock(undefined, ref) is the same
  // "no such block" payload the Postgres tier produces, and returning it here
  // (rather than null) stops the caller re-deriving it.
  return buildBlock(rows[0] as never, ref);
}
