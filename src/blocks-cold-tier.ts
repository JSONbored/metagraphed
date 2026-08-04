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
import { type ChainNetworkId, DEFAULT_CHAIN_NETWORK } from "./chain-network.ts";
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

// `blocks_head` carries only the core columns (block_number, block_hash,
// parent_hash, extrinsic_count, observed_at). `spec_version` and the per-block
// event count live in the live-follow hot tier's coverage register
// (`chain_detail_blocks`, #9240) -- the SAME D1 database, keyed by the same
// block_number -- so reading blocks_head alone published `event_count: null`
// for every block above the seam even though the count was sitting one join
// away. The UI renders that null as `0`, so a block with 320 events showed
// "Events 0" while the same page's pallet breakdown (fed by /chain-events off
// the hot tier) said 320.
//
// LEFT, never INNER: the hot tier keeps a SHORTER window than blocks_head
// (measured 2026-08-04: chain_detail_blocks 8,769,690-8,771,490 vs blocks_head
// 8,755,245-8,771,492). A block the hot tier has pruned past must still return
// its core columns with an honest null count -- null means "not known here",
// which is exactly what it meant before, just no longer for blocks the register
// does hold.
//
// `event_count` is the RAW pallet-event count, matching what the lakehouse
// column of that name means below the seam: verified on block 8,771,000, where
// the lakehouse reports 268 and /chain-events counts 268. That is
// `chain_event_count`, NOT `account_event_count` (the curated subset).
const D1_SELECT =
  "b.block_number, b.block_hash, b.parent_hash, b.extrinsic_count, " +
  "b.observed_at, c.spec_version AS spec_version, " +
  // COALESCE, indexer first (#9417): chain_detail_blocks' count comes from a
  // full SCALE decode of every event, blocks_head's from the Vec length prefix
  // the head poller reads. Both are exact and they agree; the decode is
  // preferred purely because it is the same number the rest of the detail
  // surface is built from. The poller's copy is what covers the seconds
  // between a block being seen and being decoded -- the window that used to
  // publish null and render "Events 0".
  "COALESCE(c.chain_event_count, b.event_count) AS event_count";
const D1_FROM =
  "blocks_head b LEFT JOIN chain_detail_blocks c " +
  "ON c.block_number = b.block_number";

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
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<number> {
  // Off mainnet the seam is not a boundary between two sources -- there is only
  // one. `blocks_head` and the whole D1 hot tier are written by the mainnet
  // firehose poller and carry no network column, so a non-mainnet request has
  // no hot rows to reach and every block must come from the lakehouse. Zero
  // says exactly that: nothing is above the seam.
  if (network !== DEFAULT_CHAIN_NETWORK) return 0;
  const floor = blocksSeamFloor(env);
  const watermark = await resolveDecodeWatermark(env, deps, network);
  return Math.max(floor, watermark?.decodedThrough ?? floor);
}

/**
 * The newest block this network's lakehouse can answer for, or null when that
 * is not knowable.
 *
 * NOT the seam, and the distinction is the whole reason this exists.
 * `resolveBlocksSeam` answers "where do the two block sources MEET", so off
 * mainnet it is 0 -- there is one source and nothing sits above it. A reader
 * with no hot leg at all needs the opposite fact: how far UP that single source
 * reaches.
 *
 * The chain-events feed and its stats aggregate are exactly those readers, and
 * both anchored on `blocksSeamFloor` -- a CONSTANT. So the all-events feed's
 * newest event stayed pinned at block 8,759,336 while the decoder appended
 * 7,200 blocks a day past it (11,746 blocks stale when measured, 2026-08-04),
 * and `/chain-events/stats`, documented as "the most recent N blocks",
 * aggregated a fixed window receding further into history every day. The same
 * anchor would have put testnet at 0.
 *
 * Mainnet keeps the configured floor as a FAIL-SAFE MINIMUM, the same guarantee
 * `resolveBlocksSeam` makes: a missing, unreadable or regressed watermark
 * cannot pull the ceiling below history the lakehouse is known to hold. Off
 * mainnet there is no such floor to fall back on -- `ICEBERG_BLOCKS_MAX` is
 * mainnet's own exodus boundary and means nothing on another chain -- so an
 * unreadable watermark yields null and the caller declines rather than picking
 * a window it cannot justify.
 */
export async function lakehouseHeadBlock(
  env: unknown,
  deps: DecodeWatermarkDeps = {},
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<number | null> {
  const watermark = await resolveDecodeWatermark(env, deps, network);
  const decodedThrough = watermark?.decodedThrough ?? null;
  if (network !== DEFAULT_CHAIN_NETWORK) return decodedThrough;
  return Math.max(blocksSeamFloor(env), decodedThrough ?? 0);
}

/**
 * Whether the D1 leg can honour this query at all. Filters over columns the
 * leg cannot evaluate for EVERY row in its range must NOT be silently
 * dropped, so their presence disqualifies the leg rather than being ignored.
 *
 * `spec_version` and `event_count` are now READABLE via the
 * chain_detail_blocks join above, but they are still not FILTERABLE here: the
 * hot tier's window is shorter than blocks_head's range, so a block outside it
 * joins to null and would be silently excluded by `spec_version = ?` or
 * `event_count >= ?` -- dropping rows the caller never excluded. Being able to
 * report a value is not the same as being able to filter on it. `author` is
 * carried by neither table, so it disqualifies the leg outright.
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

  // Every predicate is qualified to `b`: block_number, observed_at and
  // extrinsic_count all exist on BOTH sides of the join, so an unqualified
  // reference is an "ambiguous column name" error, not a silent wrong answer.
  const where: string[] = ["b.block_number > ?"];
  const params: unknown[] = [seam];
  if (cursor) {
    // The same 2-part (observed_at, block_number) seek the other tiers issue
    // for this token; SQLite row values keep it a single bound comparison.
    where.push("(b.observed_at, b.block_number) < (?, ?)");
    params.push(cursor[0], cursor[1]);
  }
  for (const [value, clause] of [
    [query.blockStart, "b.block_number >= ?"],
    [query.blockEnd, "b.block_number <= ?"],
    [query.from, "b.observed_at >= ?"],
    [query.to, "b.observed_at <= ?"],
    [query.minExtrinsics, "b.extrinsic_count >= ?"],
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
        `SELECT ${D1_SELECT} FROM ${D1_FROM} WHERE ${where.join(" AND ")}
         ORDER BY b.observed_at DESC, b.block_number DESC LIMIT ?`,
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
  /** Which chain to read (#8700). Off mainnet there is no D1 hot tier, so the
   * whole feed comes from that network's lakehouse namespace. */
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
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

  const seam = await resolveBlocksSeam(env, {}, network);
  // Cursor pages never carry an offset (the cursor already narrows past prior
  // pages), mirroring data-api. Both legs are asked for the full window and
  // the slice happens once, after they are concatenated, because the rows an
  // offset skips may live in either source.
  const paged = cursor ? 0 : offset;
  const want = limit + paged;

  // The D1 leg is mainnet's alone: its rows have no network dimension, so
  // consulting it for another chain would splice mainnet blocks into that
  // chain's feed -- indistinguishable from real ones, since both are just
  // heights and hashes.
  const head =
    network === DEFAULT_CHAIN_NETWORK && d1CanServe(query)
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
    const lake = await fetchBlockRowsFromR2Sql(
      env,
      {
        ...query,
        limit: want - rows.length,
        offset: 0,
        cursor: continuation ?? query.cursor,
        // The ceiling exists only to stop the lake leg re-serving rows the D1 leg
        // already covered. Off mainnet there IS no D1 leg, so there is nothing to
        // exclude and a ceiling would be actively wrong: the seam is 0 there, so
        // `block_number < seam + 1` would cap the whole feed at block 0.
        ceilingBlock:
          network !== DEFAULT_CHAIN_NETWORK || lastHead ? null : seam + 1,
      },
      network,
    );
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
  /** Which chain to read (#8700). */
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<ReturnType<typeof buildBlock> | null> {
  const seam = await resolveBlocksSeam(env, {}, network);
  const asNumber = safeBlockNumber(ref);
  const asHash = asNumber === null ? safeHexLiteral(ref) : null;
  if (asNumber === null && asHash === null) return null;

  // Mainnet-only, for the same reason the feed's head leg is.
  const db =
    network === DEFAULT_CHAIN_NETWORK
      ? bindings(env).METAGRAPH_HEALTH_DB
      : undefined;
  // "Above the seam" means "too new for the lakehouse, so D1 is the only
  // source" — a statement that is only true on mainnet, because only mainnet
  // HAS a D1 tier. Off mainnet the lakehouse is the sole source at every
  // height, so nothing is ever above the seam.
  //
  // Guarding on the network rather than on the seam VALUE, because the value
  // is 0 there (see resolveBlocksSeam) and `n > 0` is true for every real
  // block — which made every testnet block short-circuit to an empty result at
  // the `if (aboveSeam)` below, without ever reaching the lakehouse that had
  // it. The feed did not share the bug: it uses the seam as a ceiling, not as
  // a source switch, so the same 0 meant the right thing there.
  const aboveSeam =
    network === DEFAULT_CHAIN_NETWORK && asNumber !== null && asNumber > seam;
  if (db?.prepare && (aboveSeam || asHash !== null)) {
    try {
      const predicate =
        asNumber !== null ? "b.block_number = ?" : "lower(b.block_hash) = ?";
      const value = asNumber !== null ? asNumber : asHash!;
      const res = await db
        .prepare(
          `SELECT ${D1_SELECT} FROM ${D1_FROM} WHERE ${predicate} LIMIT 1`,
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
  return loadBlockFromR2Sql(env, ref, network);
}
