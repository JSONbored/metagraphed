// Account-event reads served from the lakehouse when the Postgres tier
// misses. Third member of the cold-tier family (blocks, extrinsics, now
// events), same posture throughout: rows feed the SAME src/account-events.ts
// formatters the Postgres tier feeds, filters decline rather than degrade,
// and cursors are data-api's own tokens so paging survives a tier transition.
//
// ONE DELIBERATE SIMPLIFICATION, equivalence argued not assumed. data-api
// reads an account's events as TWO scans (hotkey = X, then coldkey = X AND
// hotkey <> X) merged client-side -- an index-shape optimization for
// Postgres. R2 SQL has no indexes to shape around, so this tier issues the
// single disjunction `(hotkey = X OR coldkey = X)`. The row SETS are
// identical: the two-scan form's second branch merely excludes rows the
// first already returned, which a single OR cannot double-count. (OR support
// verified on the live engine, 2026-08-02.)
//
// NO SEAM GATE HERE EITHER, for the reason spelled out at the top of
// src/extrinsics-cold-tier.ts: the seam picks between two sources and this
// family has one, so the lakehouse's own empty answer is more truthful than a
// prediction made from a four-table `min` watermark.
//
// TWO STREAMS, ONE BLOCK. Everything above reads `chain.account_events`, the
// curated projection that names an account. `loadBlockChainEventsColdTier` at
// the bottom reads `chain.chain_events`, the RAW every-event stream, and it
// lives here rather than in a module of its own precisely because the two
// per-block readers must sit side by side: `/blocks/{n}/events` and
// `/blocks/{n}/chain-events` are two views of one block, and #9260 happened
// because one of them had a reader and the other did not. The raw one is the
// larger stream (894M rows against the projection's own count) and its rows go
// through formatChainEvent, the SAME formatter the hot tier feeds -- so a
// caller cannot tell which tier answered, which is the entire point.

import {
  buildAccountEvents,
  buildBlockEvents,
  buildSubnetEvents,
} from "./account-events.ts";
import {
  accountEventsHotFloorMs,
  loadAccountEventsHotTier,
  CHAIN_EVENT_COLUMNS,
  formatChainEvent,
  type ChainEventApi,
} from "./chain-detail-hot-tier.ts";
import { decodeCursor, encodeCursor } from "./cursor.ts";
import {
  type ChainNetworkId,
  DEFAULT_CHAIN_NETWORK,
  chainTable,
} from "./chain-network.ts";
import {
  accountHistoryFloorMs,
  loadAccountSummaryProjection,
} from "./account-summary-projection.ts";
import {
  mergeNewestEvents,
  type AccountFeedRow,
  type FeedKeyed,
} from "./account-feeds-cold-tier.ts";
import {
  r2SqlQuery,
  safeBlockNumber,
  safeHexLiteral,
  safeNameLiteral,
  safeSs58Literal,
} from "./r2-sql.ts";
import { offsetBeyondEmulationCap } from "./r2-sql-blocks.ts";
import { windowedRowRead } from "./account-events-window.ts";
import { ACCOUNT_EVENTS_COLUMNS } from "../generated/lakehouse/types.ts";
import type { AccountEventsRow } from "../generated/lakehouse/types.ts";
import type { R2SqlEnv } from "./r2-sql.ts";

/** Kept identical to the Postgres tier's SELECT list so both tiers hand the
 * formatter the same shape. */
// The generated tuple, not a retyped copy -- see src/r2-sql-blocks.ts for why.
// This exact eleven-name list was written out by hand in four separate files;
// they now share one source.
const EVENT_COLUMNS = ACCOUNT_EVENTS_COLUMNS.join(", ");

/** The 3-part key the account-events feed pages on, mirroring data-api. */
const CURSOR_ARITY = 3;

// The window constants and the walk itself live in ./account-events-window.ts
// since #11131, when the transfer feed, the counterparty scans and the summary
// card came to need the same bound. Not re-exported from here: nothing imports
// them through this module, and an export nothing reads is the debt
// validate:unreferenced-exports exists to stop.

export interface AccountEventsQuery {
  limit: number;
  offset?: number | null;
  cursor?: unknown;
  kind?: unknown;
  netuid?: unknown;
  blockStart?: unknown;
  blockEnd?: unknown;
}

/**
 * One account's events (hotkey OR coldkey side), newest first. Returns null
 * when the lakehouse cannot answer faithfully, so the caller keeps its
 * existing fallback.
 */
/**
 * The account's newest events, served from the projection instead of the walk.
 *
 * THE HOT TIER THIS FAMILY ALREADY HAD AND DID NOT USE. metagraphed-infra#575
 * publishes each account's newest N events as COMPLETE ROWS -- block_number,
 * event_index, event_kind, hotkey, coldkey, netuid, uid, amount_tao,
 * alpha_amount, observed_at -- and generation 20260816T173020Z is the first to
 * carry them (`recent_limit: 10`, `recent_from: 2026-07-16`, 814,072 accounts).
 * `readRecent` had exactly ONE consumer: the summary card. A request for the
 * newest five events walked the lakehouse while the newest ten sat in a 63 KB
 * object the same page load had already fetched.
 *
 * ## Why this is a latency fix and the bounds were a cost fix
 *
 * R2 SQL costs seconds per query almost regardless of what it scans -- measured
 * 2026-08-16, `/events?limit=5` on 5EEmaGFE...5oM3qDSC took 6.0s AFTER its scan
 * was floored to five days, while the card answered in 174ms because it issues
 * no query at all. #11425 and #11431 cut bytes and query count, which is real
 * money; neither can get under the per-query floor. Not querying does.
 *
 * ONE PROBE REMAINS, and it is not optional: the projection describes events at
 * or before its fold edge, so anything newer is missing from it. `floorMs` is
 * where the producer stopped, so a single bounded read covers exactly the gap
 * -- against the walk's two-to-three reads over the account's whole span.
 *
 * ## What makes serving it EXACT rather than approximately right
 *
 * `readRecent` only returns a list when that list IS the newest
 * `min(published, lifetime)` events -- it declines a short one rather than
 * handing back a truncated page. So the first `limit` of it are the newest
 * `limit` overall, and `mergeNewestEvents` re-sorts them with the head probe on
 * the feed's own three-part key. The page is byte-identical to the walk's,
 * which is what lets the caller's cursor stay unchanged.
 *
 * ## Every reason this DECLINES, and why each has to
 *
 *   any filter      `kind`, `netuid`, `blockStart`, `blockEnd`. The published
 *                   list is the newest N UNFILTERED; the newest N matching a
 *                   filter are not a subset of it -- an account whose ten
 *                   newest are all one kind has none of another in the list
 *                   while having plenty in the chain. Filtering here would
 *                   answer "none" with total confidence.
 *   a cursor        the list is page 1 by construction. A seek token asks for
 *                   rows below a point the projection may not reach.
 *   an offset       same argument: `offset` skips into a region the list does
 *                   not describe.
 *   limit > rows    the list holds `min(recent_limit, lifetime)` rows. Asking
 *                   for more than it holds cannot be answered from it, because
 *                   a short list here is indistinguishable from a short account.
 *   another network the projection is mainnet's.
 *
 * A decline costs one R2 GET of an object the card has usually warmed, and
 * falls through to exactly the walk that ran before this existed.
 */
async function recentEventsLeg(
  env: R2SqlEnv | null | undefined,
  options: {
    ss58: string;
    where: readonly string[];
    limit: number;
    network: ChainNetworkId;
    /**
     * The generic reader, not `R2SqlReader`. `r2SqlQuery` derives the catalog
     * schema from the table named in the SQL and refuses any row that violates
     * it, so naming the row type here is "validated, then named" -- which is
     * what `validate:untyped-db-reads` sits at a ceiling of zero to require.
     * `R2SqlReader` erases that to `Record<string, unknown>` and would count
     * against it.
     */
    query: typeof r2SqlQuery;
  },
): Promise<AccountFeedRow[] | null> {
  const { ss58, where, limit, network, query } = options;
  if (network !== DEFAULT_CHAIN_NETWORK) return null;
  const projected = await loadAccountSummaryProjection(env, ss58, {
    recentLimit: limit,
  });
  if (projected === null || projected.absent === true) return null;
  const recent = projected.recent;
  // NO LENGTH CHECK, and the first version of this had one -- `rows.length <
  // limit` -- which was both redundant and WRONG IN THE DIRECTION THAT MATTERS.
  //
  // `readRecent` returns a list only when two things already hold: the pointer
  // publishes at least `limit` events per account (it declines when
  // `recent_limit < need`), and the list is COMPLETE for this account (it
  // declines when the list is shorter than `min(published, lifetime)`). So a
  // list that arrives here is the newest `min(published, lifetime)` events --
  // every event the account has, when it has fewer than the limit asked for.
  //
  // Measured 2026-08-16 on 5EEmaGFE...5oM3qDSC, whose whole history is two
  // events: `?limit=5` saw a two-row list, read it as "not enough", and walked
  // the lakehouse anyway -- 13.4s. The check rejected exactly the quiet accounts
  // the hot tier is cheapest for, which is most of them.
  if (recent === null) return null;

  // THE HEAD, FROM NEON WHEN THE TWO TIERS PROVABLY MEET.
  //
  // `chain_detail_account_events` holds the head of the chain in Neon and is
  // indexed by account since migration 0032: measured 0.091 ms against 748 ms
  // before it, and against seconds for the same question in R2 SQL. The
  // projection covers everything at or before its fold edge; this store covers
  // everything from its own floor upward. When that floor sits at or below the
  // fold edge the two OVERLAP and together span all of time -- so the whole
  // page is served with NO lakehouse query at all.
  //
  // Measured 2026-08-16: hot floor 22:27Z against a fold edge of 00:00Z, an
  // overlap of about ninety minutes.
  //
  // CHECKED, NEVER ASSUMED. Both edges move on their own schedules -- the
  // chain-detail lane prunes to a rolling window, the producer folds on its own
  // cadence -- so a gap is possible and a page built across one would be
  // silently missing every event in it. `accountEventsHotFloorMs` derives the
  // floor from the store rather than pinning it, and anything but a proven
  // overlap falls through to the bounded R2 SQL probe below, which is slower
  // and correct.
  const hotFloorMs = await accountEventsHotFloorMs(env);
  if (hotFloorMs !== null && hotFloorMs <= recent.floorMs) {
    const hot = await loadAccountEventsHotTier(env, ss58, limit);
    // A hot-tier failure is not a decline: it means this leg could not be
    // served from Neon, and the R2 SQL probe below answers the same question.
    if (hot !== null) {
      return mergeNewestEvents<AccountFeedRow>(recent.rows, hot, limit);
    }
  }

  const head = await query<AccountEventsRow>(
    env,
    `SELECT ${EVENT_COLUMNS} FROM ${chainTable("account_events", network)} ` +
      `WHERE ${where.join(" AND ")} ` +
      `AND observed_at >= ${Math.trunc(recent.floorMs)}` +
      ` ORDER BY observed_at DESC, block_number DESC, event_index DESC` +
      ` LIMIT ${limit}`,
  );
  // A FAILED PROBE FAILS THE LEG rather than serving the published half alone.
  // The missing rows would be the NEWEST ones -- the top of the feed -- and the
  // payload carries nothing that could say they were dropped. Returning null
  // falls through to the walk, which is slower and complete.
  if (head === null) return null;

  // BOTH HALVES ARE ALREADY VALIDATED, each by the reader that owns it, and
  // neither is cast into place:
  //
  //   published  `AccountSummaryRecentSchema` inside `readRecent` -- required
  //              and `.strict()`, because a published artifact writes whole
  //              rows and a missing column there is a producer bug
  //   probe      `r2SqlQuery` itself, which derives the catalog schema from the
  //              table named in the SQL and refuses any row that violates it
  //              (src/r2-sql.ts) -- returning null, which is the branch above
  //
  // A second `safeParse` here was the first version of this, and it was
  // DUPLICATED VALIDATION: the same rows checked twice against the same
  // generated schema, with a second decline path to keep in step with the
  // first. One owner per boundary.
  //
  // `mergeNewestEvents` is generic over the shape both halves share, so the
  // compiler still checks that these two really do describe the same rows --
  // the job that the `as unknown as` this replaced was destroying.
  return mergeNewestEvents<AccountFeedRow>(recent.rows, head, limit);
}

export async function loadAccountEventsColdTier(
  env: R2SqlEnv | null | undefined,
  ss58: string,
  query: AccountEventsQuery,
  /** Which chain's lakehouse namespace to read (#8700). */
  network?: ChainNetworkId,
): Promise<ReturnType<typeof buildAccountEvents> | null> {
  const limit = safeBlockNumber(query.limit);
  const offset = safeBlockNumber(query.offset ?? 0);
  if (limit === null || offset === null || limit <= 0) return null;
  if (offsetBeyondEmulationCap(offset)) return null;

  // An unusable address is a decline, not an unfiltered scan of every account.
  const addr = safeSs58Literal(ss58);
  if (addr === null) return null;
  const where = [`(hotkey = '${addr}' OR coldkey = '${addr}')`];

  if (query.kind != null) {
    const kind = safeNameLiteral(query.kind);
    if (kind === null) return null;
    where.push(`event_kind = '${kind}'`);
  }
  for (const [value, clause] of [
    [query.netuid, "netuid ="],
    [query.blockStart, "block_number >="],
    [query.blockEnd, "block_number <="],
  ] as [unknown, string][]) {
    if (value == null) continue;
    const n = safeBlockNumber(value);
    if (n === null) return null;
    where.push(`${clause} ${n}`);
  }
  const cursor = decodeCursor(query.cursor, CURSOR_ARITY);
  if (cursor) {
    // data-api's exact 3-part tuple seek; an invalid token means page 1,
    // exactly as data-api treats it.
    where.push(
      `(observed_at, block_number, event_index) < ` +
        `(${cursor[0]}, ${cursor[1]}, ${cursor[2]})`,
    );
  }

  // THE SAME FLOOR THE SUMMARY CARD USES (#11410/#11411), on the route the
  // summary's own 503 told callers to fall back to -- which made the documented
  // fallback the slowest read of the three. Measured 2026-08-16 on
  // 5EEmaGFE...5oM3qDSC: 26.7s for `?limit=5`, against 8.1s for the card the
  // projection now bounds.
  //
  // ONE LOWER BOUND, and it holds for BOTH projection answers:
  //   - ABSENT: the producer writes every shard, so absence from a shard that
  //     exists proves there is nothing at or before `through`.
  //   - PRESENT: the groups are a lifetime aggregate, so nothing exists before
  //     `firstMs`. Post-fold events sit above `foldFloorMs`, which is itself
  //     above `firstMs` -- so the single floor covers the whole history.
  //
  // A LOWER BOUND ONLY, deliberately. The summary can split its read in two
  // because it answers one shape; this route carries cursors, an offset and
  // three optional filters, and a second window would have to compose with all
  // of them. A floor composes with anything: it removes rows that cannot exist,
  // whatever else is being asked.
  //
  // MAINNET ONLY. The projection is written for the default network, so reading
  // it for another chain would floor a feed against the wrong history. Other
  // networks keep the unbounded walk -- correct, just not faster.
  const floorMs = await accountHistoryFloorMs(env, ss58, network);
  if (floorMs !== null) where.push(`observed_at >= ${Math.trunc(floorMs)}`);

  // Cursor pages never carry an offset, mirroring data-api.
  const paged = cursor ? 0 : offset;

  // THE HOT TIER FIRST, when the request is one the projection can answer
  // exactly -- see `recentEventsLeg` for every reason it declines. Placed after
  // `where` is assembled so the head probe carries the identical predicate, and
  // gated on the absence of every narrowing the published list cannot express.
  if (
    cursor === null &&
    paged === 0 &&
    query.kind == null &&
    query.netuid == null &&
    query.blockStart == null &&
    query.blockEnd == null
  ) {
    const hot = await recentEventsLeg(env, {
      ss58,
      where,
      limit,
      network: network ?? DEFAULT_CHAIN_NETWORK,
      query: r2SqlQuery,
    });
    // `paged` is 0 here by the guard above -- the hot tier only ever serves an
    // unpaged first page -- and passing it explicitly keeps that visible at the
    // call site rather than relying on the reader to re-derive it.
    if (hot !== null) return pageOf(hot, ss58, limit, offset, 0);
  }

  const rows = await windowedRowRead<AccountEventsRow>(env, {
    table: chainTable("account_events", network),
    columns: EVENT_COLUMNS,
    where,
    order: ` ORDER BY observed_at DESC, block_number DESC, event_index DESC`,
    need: limit + paged,
    // cursor[0] is the token's `observed_at`, the column the walk slices on.
    ceiling: cursor ? (cursor[0] as number) : null,
    // The same floor already in `where`, told to the walk so it stops when it
    // reaches it instead of reading a range its own predicate excludes.
    floorMs,
  });
  if (rows === null) return null;
  return pageOf(rows, ss58, limit, offset, paged);
}

/**
 * One page and its seek token, from rows either tier produced.
 *
 * SHARED SO THE TWO TIERS CANNOT DIVERGE. The cursor is built from the last row
 * of the page, so a hot-tier page that paginated differently from the walk's
 * would hand the caller a token that skips or repeats rows on page 2 -- and
 * page 2 always goes to the walk, because a cursor makes the request
 * hot-tier-ineligible. The rows are identical by construction; this makes the
 * token identical by construction too.
 */
function pageOf<Row extends FeedKeyed & Record<string, unknown>>(
  rows: Row[],
  ss58: string,
  limit: number,
  offset: number,
  paged: number,
): ReturnType<typeof buildAccountEvents> {
  const page = paged > 0 ? rows.slice(paged) : rows;
  const last = page.length === limit ? page[page.length - 1] : null;
  const nextCursor = last
    ? encodeCursor([
        safeBlockNumber(last.observed_at),
        safeBlockNumber(last.block_number),
        safeBlockNumber(last.event_index),
      ])
    : null;
  return buildAccountEvents(page, ss58, { limit, offset, nextCursor });
}

export interface SubnetEventsQuery {
  limit: number;
  offset?: number | null;
  cursor?: unknown;
  kind?: unknown;
  blockStart?: unknown;
  blockEnd?: unknown;
}

/**
 * One subnet's events, newest first.
 *
 * NOT A PORT OF A POSTGRES QUERY — there was nothing to port. data-api never
 * registered `/api/v1/subnets/:netuid/events`, so this route's
 * tryDataApiTier call has always missed and the handler has always fallen
 * through to buildSubnetEvents([]) — the feed read empty even while the box
 * was alive. Live proof of the gap: /subnets/1/events reported event_count 0
 * while /subnets/1/stake-flow counted 1,142 stake events over the same subnet
 * and window, both derived from this one stream.
 *
 * The shape is therefore taken from the account feed above rather than from a
 * prior query: same table, same SELECT list, same newest-first ordering, and
 * the SAME 3-part (observed_at, block_number, event_index) cursor token — so a
 * client paging this feed uses tokens interchangeable with the account feed's,
 * and both hand rows to formatters that share formatAccountEvent.
 *
 * Verified against the live engine before shipping (2026-08-03): netuid = 1
 * returns real rows newest-first, `event_kind` + block-range filters compose
 * (861 rows for StakeAdded over blocks 8,700,000-8,759,336), and the tuple
 * seek continues correctly past its cursor.
 */
export async function loadSubnetEventsColdTier(
  env: R2SqlEnv | null | undefined,
  netuid: number,
  query: SubnetEventsQuery,
  /** Which chain's lakehouse namespace to read (#8700). */
  network?: ChainNetworkId,
): Promise<ReturnType<typeof buildSubnetEvents> | null> {
  const limit = safeBlockNumber(query.limit);
  const offset = safeBlockNumber(query.offset ?? 0);
  if (limit === null || offset === null || limit <= 0) return null;
  if (offsetBeyondEmulationCap(offset)) return null;

  // An unusable netuid is a decline, not an unfiltered scan of every subnet.
  const subnet = safeBlockNumber(netuid);
  if (subnet === null) return null;
  const where = [`netuid = ${subnet}`];

  if (query.kind != null) {
    const kind = safeNameLiteral(query.kind);
    if (kind === null) return null;
    where.push(`event_kind = '${kind}'`);
  }
  for (const [value, clause] of [
    [query.blockStart, "block_number >="],
    [query.blockEnd, "block_number <="],
  ] as [unknown, string][]) {
    if (value == null) continue;
    const n = safeBlockNumber(value);
    if (n === null) return null;
    where.push(`${clause} ${n}`);
  }
  const cursor = decodeCursor(query.cursor, CURSOR_ARITY);
  if (cursor) {
    where.push(
      `(observed_at, block_number, event_index) < ` +
        `(${cursor[0]}, ${cursor[1]}, ${cursor[2]})`,
    );
  }

  // Cursor pages never carry an offset, mirroring the account feed.
  const paged = cursor ? 0 : offset;
  const rows = await r2SqlQuery<AccountEventsRow>(
    env,
    `SELECT ${EVENT_COLUMNS} FROM ${chainTable("account_events", network)} WHERE ${where.join(" AND ")}` +
      ` ORDER BY observed_at DESC, block_number DESC, event_index DESC` +
      ` LIMIT ${limit + paged}`,
  );
  if (rows === null) return null;

  const page = paged > 0 ? rows.slice(paged) : rows;
  const last = page.length === limit ? page[page.length - 1] : null;
  const nextCursor = last
    ? encodeCursor([
        safeBlockNumber(last.observed_at),
        safeBlockNumber(last.block_number),
        safeBlockNumber(last.event_index),
      ])
    : null;
  return buildSubnetEvents(page, subnet, { limit, offset, nextCursor });
}

/**
 * Every event in one block, in natural read order (event_index ASC — the one
 * feed in this family that is not newest-first, because a block is read
 * top-to-bottom). `ref` is a height or a block hash.
 */
export async function loadBlockEventsColdTier(
  env: R2SqlEnv | null | undefined,
  ref: string,
  page: { limit: number; offset?: number | null },
  /** Which chain's lakehouse namespace to read (#8700). */
  network?: ChainNetworkId,
): Promise<ReturnType<typeof buildBlockEvents> | null> {
  const limit = safeBlockNumber(page.limit);
  const offset = safeBlockNumber(page.offset ?? 0);
  if (limit === null || offset === null || limit <= 0) return null;
  if (offsetBeyondEmulationCap(offset)) return null;

  const height = await resolveBlockHeight(env, ref, network);
  if (height === null) return null;

  const rows = await r2SqlQuery<AccountEventsRow>(
    env,
    `SELECT ${EVENT_COLUMNS} FROM ${chainTable("account_events", network)} ` +
      `WHERE block_number = ${height} ` +
      `ORDER BY event_index ASC LIMIT ${limit + offset}`,
  );
  if (rows === null) return null;
  const window = offset > 0 ? rows.slice(offset) : rows;
  // A short read PROVES the end of the block was reached, so `rows.length` is
  // the block's true total -- free, no second query. A full read means there may
  // be more beyond the window, so the total stays unknown and `event_count`
  // falls back to the page length rather than inventing a ceiling.
  const totalCount = rows.length < limit + offset ? rows.length : null;
  return buildBlockEvents(window, ref, height, { limit, offset, totalCount });
}

/** A block hash resolved to its height, or the height itself. */
async function resolveBlockHeight(
  env: R2SqlEnv | null | undefined,
  ref: string,
  /** Which chain's lakehouse namespace to read (#8700). */
  network?: ChainNetworkId,
): Promise<number | null> {
  const asNumber = safeBlockNumber(ref);
  if (asNumber !== null) return asNumber;
  const asHash = safeHexLiteral(ref);
  if (asHash === null) return null;
  const rows = await r2SqlQuery(
    env,
    `SELECT block_number FROM ${chainTable("blocks", network)} WHERE block_hash = '${asHash}' LIMIT 1`,
  );
  if (rows === null) return null;
  return safeBlockNumber(rows[0]?.block_number);
}

/** The payload `/api/v1/blocks/{n}/chain-events` has always published, built
 * here from lakehouse rows and by src/chain-detail-hot-tier.ts from store rows. */
export interface BlockChainEventsColdResult {
  block_number: number;
  count: number;
  events: ChainEventApi[];
}

/**
 * Every RAW chain event in one block, in natural read order (#9260).
 *
 * THE ROUTE THIS CLOSES WAS EMPTY FOR ALL OF HISTORY. #9240 gave
 * `/blocks/{n}/chain-events` a hot tier above the decode seam and deliberately
 * left the cold leg null, so the ~8.76M blocks at or below the seam answered
 * `ok: true` with `events: []` -- indistinguishable from a block that emitted
 * nothing, and contradicted by the block header's own `event_count` (block
 * 1,000 advertised 21 while this route served 0). The rows were there the whole
 * time: `chain.chain_events`, verified row-for-row during the migration.
 *
 * NO LIMIT, deliberately, and matching the hot tier exactly. A block is a
 * bounded unit -- the largest observed carries 667 chain events
 * (src/chain-detail-prune.ts's measured per-block maxima) -- so there is no
 * page to serve, and a cap chosen "for safety" would silently truncate the one
 * block that exceeded it into a shorter feed that still looked complete.
 *
 * `args` is an opaque JSON string in Iceberg exactly as it is TEXT in D1, and
 * it is decoded ONCE, by formatChainEvent, through the serve-time normalizers
 * both tiers already share -- never a second decoder for the same bytes.
 *
 * Returns null when the lakehouse cannot answer (unconfigured, failed query,
 * or a ref that resolves to no height), so the caller keeps its own decline or
 * schema-stable empty rather than inventing one here.
 */
export async function loadBlockChainEventsColdTier(
  env: R2SqlEnv | null | undefined,
  ref: string,
  /** Which chain's lakehouse namespace to read (#8700). */
  network?: ChainNetworkId,
): Promise<BlockChainEventsColdResult | null> {
  const height = await resolveBlockHeight(env, ref, network);
  if (height === null) return null;

  const rows = await r2SqlQuery(
    env,
    `SELECT ${CHAIN_EVENT_COLUMNS} FROM ${chainTable("chain_events", network)} ` +
      `WHERE block_number = ${height} ORDER BY event_index ASC`,
  );
  if (rows === null) return null;
  const events = rows
    .map(formatChainEvent)
    .filter((event): event is ChainEventApi => Boolean(event));
  return { block_number: height, count: events.length, events };
}
