// Block reads for a world with no self-hosted Postgres.
//
// TWO COLD SOURCES, ONE SEAM. The verified history lives in the R2 lakehouse
// (Iceberg, row-count-verified against the box before it was wiped) and stops
// at a known height. Everything after that height exists only in D1's
// `blocks_head`, written by the firehose head poller. The seam between them is
// that height -- a constant, not a guess:
//
//   block_number <= seam   -> R2 SQL (authoritative, full column set)
//   block_number >  seam   -> D1 blocks_head (live, reduced column set)
//
// A SEAM RATHER THAN A MERGE is the important choice. The two sources overlap
// in range (the poller was running before the export was cut), so stitching by
// "whatever D1 has" would serve observer-copied rows in a range where verified
// rows exist, silently downgrading columns for blocks we hold good data for.
// Routing on a fixed height makes each block come from exactly one source, so
// the boundary is reproducible instead of depending on what the poller
// happened to retain. When a reconciling backfill later lands more verified
// history in the lakehouse, the seam moves forward by config -- no code change.
//
// COLUMN COVERAGE IS NOT UNIFORM, and this module does not pretend otherwise.
// `blocks_head` carries block_number, block_hash, parent_hash, extrinsic_count
// and observed_at. It has no author, spec_version, or event_count, so above
// the seam those fields are null and any FILTER on them cannot be honoured.
// Rather than answer such a filter with rows that ignore it, the D1 leg is
// skipped entirely for those queries and only the lakehouse range is served --
// an incomplete answer is recoverable, a wrong one is not. See
// `d1CanServe` for the exact predicate.

import { buildBlock, buildBlockFeed } from "./blocks.ts";
import {
  fetchBlockRowsFromR2Sql,
  loadBlockFromR2Sql,
  type BlockFeedQuery,
} from "./r2-sql-blocks.ts";
import { safeBlockNumber, safeHexLiteral } from "./r2-sql.ts";

/** Highest block the lakehouse holds. Overridable so the seam can move when a
 * backfill extends verified history, without a deploy of new code. */
export const BLOCKS_SEAM_ENV = "ICEBERG_BLOCKS_MAX";

/**
 * Default seam: the maximum block_number in chain.blocks after the final
 * export + delta load (8,755,096 frozen rows plus a 1,903-row post-quiesce
 * delta). Verified against Postgres before the box was released.
 */
export const DEFAULT_BLOCKS_SEAM = 8_756_998;

/** Columns blocks_head actually has. Anything else is null above the seam. */
const D1_COLUMNS =
  "block_number, block_hash, parent_hash, extrinsic_count, observed_at";

interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all?(): Promise<{ results?: unknown[] } | null>;
    };
  };
}

/** The two bindings this module reads, independent of the full Env shape so
 * the module stays testable with a plain object. */
interface ColdTierBindings {
  METAGRAPH_HEALTH_DB?: D1Like;
  ICEBERG_BLOCKS_MAX?: unknown;
}

function bindings(env: unknown): ColdTierBindings {
  return (env ?? {}) as ColdTierBindings;
}

export function blocksSeam(env: unknown): number {
  const parsed = safeBlockNumber(bindings(env)[BLOCKS_SEAM_ENV]);
  return parsed ?? DEFAULT_BLOCKS_SEAM;
}

/**
 * Whether the D1 leg can honour this query at all. Filters over columns
 * blocks_head does not carry must NOT be silently dropped, so their presence
 * disqualifies the leg rather than being ignored.
 */
export function d1CanServe(query: BlockFeedQuery): boolean {
  return (
    query.author == null && query.specVersion == null && query.minEvents == null
  );
}

/** Rows above the seam, newest first. Bound parameters throughout — D1 has
 * them, so unlike the R2 SQL leg there is no literal-building here. */
async function d1HeadRows(
  env: Env | null | undefined,
  query: BlockFeedQuery,
  cursor: number | null,
  seam: number,
  want: number,
): Promise<Record<string, unknown>[] | null> {
  const db = bindings(env).METAGRAPH_HEALTH_DB;
  if (!db?.prepare || want <= 0) return null;

  const where: string[] = ["block_number > ?"];
  const params: unknown[] = [seam];
  // `cursor` arrives already validated by the caller, which needs it for the
  // seam arithmetic anyway; re-parsing it here would be a second source of
  // truth for the same value.
  if (cursor !== null) {
    where.push("block_number < ?");
    params.push(cursor);
  }
  for (const [value, clause] of [
    [query.blockStart, "block_number >= ?"],
    [query.blockEnd, "block_number <= ?"],
    [query.minExtrinsics, "extrinsic_count >= ?"],
  ] as [unknown, string][]) {
    if (value == null) continue;
    const n = safeBlockNumber(value);
    // Decline the leg rather than drop an unparseable filter: dropping it
    // would return rows the caller explicitly excluded.
    if (n === null) return null;
    where.push(clause);
    params.push(n);
  }

  try {
    const res = await db
      .prepare(
        `SELECT ${D1_COLUMNS} FROM blocks_head WHERE ${where.join(" AND ")}
         ORDER BY block_number DESC LIMIT ?`,
      )
      .bind(...params, want)
      .all?.();
    const rows = res?.results;
    return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
  } catch {
    // A cold or unbound D1 must not fail the request: the lakehouse leg below
    // still has every block up to the seam.
    return null;
  }
}

/**
 * The block feed, stitched across both cold sources. Returns null when neither
 * can answer, so the caller keeps its schema-stable empty.
 */
export async function loadBlockFeedColdTier(
  env: Env | null | undefined,
  query: BlockFeedQuery,
): Promise<ReturnType<typeof buildBlockFeed> | null> {
  const limit = safeBlockNumber(query.limit);
  const offset = safeBlockNumber(query.offset ?? 0);
  if (limit === null || offset === null || limit <= 0) return null;

  // Validate the cursor ONCE, here, and decline on a bad one. Leaving it to
  // the legs lets an unparseable cursor fall back to "no cursor" further down,
  // which silently serves the FIRST page to a caller who asked for a later
  // one -- a wrong answer that looks entirely healthy.
  const cursor = query.cursor == null ? null : safeBlockNumber(query.cursor);
  if (query.cursor != null && cursor === null) return null;

  // An inverted range matches nothing, at any height, in either source. Answer
  // it here rather than issuing two queries to prove an impossible result --
  // the same reason the D1-era handler short-circuited it, and the reason a
  // public caller cannot use one to amplify cost.
  const lo =
    query.blockStart == null ? null : safeBlockNumber(query.blockStart);
  const hi = query.blockEnd == null ? null : safeBlockNumber(query.blockEnd);
  if (lo !== null && hi !== null && lo > hi) {
    return buildBlockFeed([], { limit, offset, nextCursor: null });
  }

  const seam = blocksSeam(env);
  // Page through the seam correctly: the rows the caller skipped may live in
  // either source, so both legs are asked for limit+offset and the slice
  // happens once, after they are concatenated.
  const want = limit + offset;

  const head = d1CanServe(query)
    ? ((await d1HeadRows(env, query, cursor, seam, want)) ?? [])
    : [];

  let rows = head;
  if (rows.length < want) {
    // Continue strictly BELOW whatever the head leg returned so a block cannot
    // appear twice; with no head rows this is the seam itself.
    const lowest = rows.length
      ? safeBlockNumber(rows[rows.length - 1]!.block_number)
      : null;
    const ceiling = lowest !== null ? lowest : seam + 1;
    // `cursor` is already validated above, so this min() can only tighten the
    // window, never quietly widen it back to the top of the chain.
    const lakeCursor = cursor !== null ? Math.min(cursor, ceiling) : ceiling;
    // RAW rows, deliberately: they are formatted once below, together with the
    // D1 rows, so both sources go through the formatter exactly the same way.
    const lake = await fetchBlockRowsFromR2Sql(env, {
      ...query,
      limit: want - rows.length,
      offset: 0,
      cursor: lakeCursor,
    });
    if (lake === null && rows.length === 0) return null;
    if (lake) rows = rows.concat(lake.rows);
  }

  const page = offset > 0 ? rows.slice(offset) : rows;
  const last = page.length === limit ? page[page.length - 1] : null;
  const nextCursor =
    last != null
      ? (safeBlockNumber(last.block_number)?.toString() ?? null)
      : null;
  return buildBlockFeed(page, { limit, offset, nextCursor });
}

/**
 * One block by height or hash, from whichever cold source owns it. A height
 * above the seam is D1's; at or below it is the lakehouse's. A hash could be
 * either, so D1 is asked first and the lakehouse answers if it misses.
 */
export async function loadBlockColdTier(
  env: Env | null | undefined,
  ref: string,
): Promise<ReturnType<typeof buildBlock> | null> {
  const seam = blocksSeam(env);
  const asNumber = safeBlockNumber(ref);
  const asHash = asNumber === null ? safeHexLiteral(ref) : null;
  if (asNumber === null && asHash === null) return null;

  const db = bindings(env).METAGRAPH_HEALTH_DB;
  const aboveSeam = asNumber !== null && asNumber > seam;
  if (db?.prepare && (aboveSeam || asHash !== null)) {
    try {
      const predicate =
        asNumber !== null ? "block_number = ?" : "lower(block_hash) = ?";
      const value = asNumber !== null ? asNumber : asHash!;
      const res = await db
        .prepare(
          `SELECT ${D1_COLUMNS} FROM blocks_head WHERE ${predicate} LIMIT 1`,
        )
        .bind(value)
        .all?.();
      const row = (res?.results as Record<string, unknown>[] | undefined)?.[0];
      if (row) return buildBlock(row as never, ref);
    } catch {
      // Fall through to the lakehouse rather than failing the request.
    }
  }

  // A height above the seam that D1 does not have is a genuine miss, not a
  // reason to scan the lakehouse for a block it cannot contain.
  if (aboveSeam) return buildBlock(undefined as never, ref);
  return loadBlockFromR2Sql(env, ref);
}
