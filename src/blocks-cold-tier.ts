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
// Routing on a single height makes each block come from exactly one source, so
// the boundary is reproducible instead of depending on what the poller
// happened to retain.
//
// THE HEIGHT IS RESOLVED, NOT PINNED. It used to be a wrangler var, and that
// made the seam a thing only a human could move: the decode lane extended the
// lakehouse hourly while the Worker kept routing against a constant from the
// last deploy, so every recently-decoded block served reduced columns forever
// (measured in production 2026-08-03 -- see src/decode-watermark.ts's header).
// The seam now comes from the watermark the decoder itself publishes, with the
// configured constant as a FLOOR beneath it. It is still ONE height per
// request -- resolved once and threaded through both legs -- so the "exactly
// one source per block" property is unchanged; only who chooses it moved.
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
import { decodeCursor, encodeCursor } from "./cursor.ts";
import {
  resolveDecodeWatermark,
  type DecodeWatermarkDeps,
} from "./decode-watermark.ts";

/** Floor for the seam, overridable per environment. NOT the seam itself any
 * more: see `resolveBlocksSeam`. */
export const BLOCKS_SEAM_ENV = "ICEBERG_BLOCKS_MAX";

/**
 * The seam FLOOR: history the lakehouse is known to hold regardless of what
 * the decode lane has published since.
 *
 * Measured 2026-08-02 against the live lakehouse (#9161): `min=0,
 * max=8,759,336, count=8,759,337` -- `count == max - min + 1`, so the range is
 * contiguous with no gaps and no duplicates. It is the height of the final
 * export plus the delta loads that followed, and it is the same number the
 * decoder's own `iceberg_r2.py seam` uses when its ledger is empty.
 *
 * As a CEILING this number went stale twice, both times invisibly, because
 * nothing re-measured it between deploys. As a floor it cannot: the published
 * watermark only raises the seam, so a constant that lags reality costs
 * nothing the moment the decoder publishes, and a constant that is somehow
 * ahead of the lakehouse still bounds the damage to the range it always did.
 */
export const DEFAULT_BLOCKS_SEAM = 8_759_336;

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

/** The configured floor: the env override when it parses, else the constant. */
export function blocksSeamFloor(env: unknown): number {
  const parsed = safeBlockNumber(bindings(env)[BLOCKS_SEAM_ENV]);
  return parsed ?? DEFAULT_BLOCKS_SEAM;
}

/**
 * The seam this request routes on: the published decode watermark when it is
 * ahead of the configured floor, the floor otherwise.
 *
 * `Math.max` is the whole fail-safe. A missing, unreadable, malformed or
 * REGRESSED watermark cannot lower the seam, so the worst case is the
 * behaviour this module had before the watermark existed. A watermark that is
 * ahead is trusted because the decoder writes its ledger property in the SAME
 * Iceberg commit as the rows -- there is no window in which it can claim a
 * height whose data is not yet visible -- and because it is the `min` across
 * all four decoded tables, so it never runs ahead of the slowest one.
 */
export async function resolveBlocksSeam(
  env: unknown,
  deps: DecodeWatermarkDeps = {},
): Promise<number> {
  const floor = blocksSeamFloor(env);
  const watermark = await resolveDecodeWatermark(env, deps);
  return Math.max(floor, watermark?.decodedThrough ?? floor);
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
  cursor: number[] | null,
  seam: number,
  want: number,
): Promise<Record<string, unknown>[] | null> {
  const db = bindings(env).METAGRAPH_HEALTH_DB;
  if (!db?.prepare || want <= 0) return null;

  const where: string[] = ["block_number > ?"];
  const params: unknown[] = [seam];
  if (cursor) {
    // The same 2-part (observed_at, block_number) seek the other tiers issue
    // for this token; SQLite row values keep it a single bound comparison.
    where.push("(observed_at, block_number) < (?, ?)");
    params.push(cursor[0], cursor[1]);
  }
  for (const [value, clause] of [
    [query.blockStart, "block_number >= ?"],
    [query.blockEnd, "block_number <= ?"],
    [query.from, "observed_at >= ?"],
    [query.to, "observed_at <= ?"],
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
         ORDER BY observed_at DESC, block_number DESC LIMIT ?`,
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

  // Decode the public token ONCE, with the shared codec and data-api's arity.
  // An invalid token decodes to null and means page 1 -- the Postgres tier's
  // exact behavior -- so both tiers serve the identical page for the
  // identical request, malformed tokens included.
  const cursor = decodeCursor(query.cursor, 2);

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

  const seam = await resolveBlocksSeam(env);
  // Cursor pages never carry an offset (the cursor already narrows past prior
  // pages), mirroring data-api. Both legs are asked for the full window and
  // the slice happens once, after they are concatenated, because the rows an
  // offset skips may live in either source.
  const paged = cursor ? 0 : offset;
  const want = limit + paged;

  const head = d1CanServe(query)
    ? ((await d1HeadRows(env, query, cursor, seam, want)) ?? [])
    : [];

  let rows = head;
  if (rows.length < want) {
    // Continue strictly BELOW whatever the head leg returned so a block cannot
    // appear twice. With head rows, the continuation is the last row's OWN
    // cursor token -- the exact mechanism a client would use, already tighter
    // than any cursor the caller sent (the D1 leg consumed it). With none,
    // an exclusive block ceiling at the seam bounds the lake leg instead.
    const lastHead = rows.length ? rows[rows.length - 1]! : null;
    const continuation = lastHead
      ? encodeCursor([
          safeBlockNumber(lastHead.observed_at),
          safeBlockNumber(lastHead.block_number),
        ])
      : null;
    // RAW rows, deliberately: they are formatted once below, together with the
    // D1 rows, so both sources go through the formatter exactly the same way.
    const lake = await fetchBlockRowsFromR2Sql(env, {
      ...query,
      limit: want - rows.length,
      offset: 0,
      cursor: continuation ?? query.cursor,
      ceilingBlock: lastHead ? null : seam + 1,
    });
    if (lake === null && rows.length === 0) return null;
    if (lake) rows = rows.concat(lake.rows);
  }

  const page = paged > 0 ? rows.slice(paged) : rows;
  const last = page.length === limit ? page[page.length - 1] : null;
  // The SAME token every other tier emits for this row, so paging survives a
  // tier transition in either direction.
  const nextCursor = last
    ? encodeCursor([
        safeBlockNumber(last.observed_at),
        safeBlockNumber(last.block_number),
      ])
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
  const seam = await resolveBlocksSeam(env);
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
