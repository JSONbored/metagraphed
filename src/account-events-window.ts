// Bounding the scan for reads that filter a SCATTERED key on
// `chain.account_events` (#11131).
//
// MEASURED, in #11132/#11133, on 455M rows across 51 files:
//
//   WHERE hotkey = X                        577.5 MB   3,480 R2 requests
//   WHERE hotkey = X AND block_number >= F     0.1 MB       9 R2 requests
//
// A hotkey/coldkey value is spread across every data file, so file statistics
// cannot prune on it and the engine opens all of them. `block_number` and
// `observed_at` are columns the writers order by, so a predicate on one prunes.
// The difference is roughly four orders of magnitude.
//
// THE HARD PART IS NOT THE BOUND, IT IS KEEPING THE ANSWER. A cold-tier read
// here either answers exactly what the Postgres tier would or DECLINES -- a
// silently-truncated feed is the one outcome this family never produces. So a
// window cannot be a fixed "last 30 days": an account whose last transfer was
// two years ago must still get that transfer, not an empty page.
//
// Both helpers below therefore WIDEN until the query's own LIMIT is satisfied,
// or until the window reaches block 0 and there is nothing left to widen into.
// The result is the same rows the unbounded query returns, and the common case
// (an account with recent activity) is satisfied by the first, smallest window.
//
// The precedent is `windowedAccountEventsRead`, which /accounts/{ss58}/events
// has used since #10190; this module is that function generalised so the
// transfer feed, the counterparty scans and the summary card can share it
// instead of each re-deriving the walk.
import { lakehouseHeadBlock } from "./blocks-cold-tier.ts";
import type { ChainNetworkId } from "./chain-network.ts";
import { r2SqlQuery } from "./r2-sql.ts";
import type { R2SqlReader } from "./r2-sql.ts";

/**
 * How many blocks the FIRST window of an account read covers.
 *
 * Measured end to end through the deployed Worker, `/accounts/{ss58}/events`
 * for a busy account, edge cache defeated:
 *
 *   unbounded                        6.35s  6.01s
 *   WHERE block_number >= head-68k   2.51s  1.76s
 *
 * ~3x, and the reason is that `account_events` is already clustered by block:
 * the decoder appends in block order, so file min/max on `block_number` prunes
 * well. The table was never the problem -- the query simply declined to use the
 * clustering it already had, and scanned all 452M rows for every page.
 *
 * The same fix `chain-events-cold-tier.ts` documents (1.93 GB -> 15.8 MB), one
 * table over. Partitioning would NOT have helped here: the predicate is
 * `(hotkey = X OR coldkey = X)`, a disjunction across two columns, so bucketing
 * on either one cannot prune -- a row matching the other side sits in any
 * bucket.
 */
export const ACCOUNT_EVENTS_BLOCK_WINDOW = 250_000;

/**
 * How wide each successive window gets when a page has not filled.
 *
 * EXPONENTIAL, NOT A FIXED STEP, because account density varies by orders of
 * magnitude. A validator has events in most blocks and fills its page from the
 * first window; an address with nine lifetime events needs to reach back
 * millions of blocks, and stepping 250k at a time would take 30+ queries to get
 * there. Quadrupling reaches the full ~8.8M-block history in six.
 */
export const WINDOW_GROWTH = 4;

/** Hard stop, so a pathological read cannot walk forever. Six windows at this
 * growth already spans the whole chain, so hitting this means the walk reached
 * block 0 anyway. */
export const MAX_WINDOW_STEPS = 8;

/** Injectable head-block reader, so tests drive the walk without a lakehouse. */
export type HeadBlockReader = typeof lakehouseHeadBlock;

export interface WindowWalkDeps {
  /** Defaults to the real r2-sql reader. */
  query?: R2SqlReader;
  /** Defaults to the real decode watermark. */
  headBlock?: HeadBlockReader;
  network?: ChainNetworkId;
}

/**
 * The block the walk starts from, or null when it cannot be established.
 *
 * AN UNKNOWABLE HEAD FALLS BACK, IT DOES NOT DECLINE. The window is only an
 * optimisation over a query that worked without one, so failing the read would
 * trade a slow answer for no answer and invent a failure mode these routes
 * never had. Callers treat null as "issue the unbounded query", which is
 * exactly what they did before this module existed.
 */
async function startBlock(
  env: Env | null | undefined,
  ceiling: number | null,
  deps: WindowWalkDeps,
): Promise<number | null> {
  const head =
    ceiling ??
    (await (deps.headBlock ?? lakehouseHeadBlock)(env, {}, deps.network));
  if (head === null || !Number.isFinite(head) || head < 0) return null;
  return head;
}

export interface WindowedRowReadOptions extends WindowWalkDeps {
  /** Fully-qualified table, e.g. `chain.account_events`. */
  table: string;
  /** The SELECT list, already joined. */
  columns: string;
  /** Predicates ANDed together; the block bound is added to them. */
  where: readonly string[];
  /** The ORDER BY clause, leading space included by the caller's constant. */
  order: string;
  /** How many rows the caller needs before it can stop. */
  need: number;
  /** The cursor's block, or null to start from the lakehouse head. */
  ceiling?: number | null;
}

/**
 * Read newest-first, widening the block window until `need` rows are collected.
 *
 * WHY THE WINDOWS ACCUMULATE RATHER THAN RE-QUERYING A WIDER RANGE. Each step
 * scans only the slice below the last one, so the total scanned is the UNION of
 * the ranges rather than the sum of prefixes. Rows arrive block-descending
 * within each slice and each slice is strictly below its predecessor, so
 * concatenation is globally ordered -- no merge, no re-sort.
 *
 * EXACTNESS. Every range is a suffix of the newest blocks and the ranges tile
 * that suffix without gaps or overlap, so the concatenation of their ordered
 * rows is the ordered row set of their union. Stopping once `need` rows are in
 * hand yields the newest `need` rows overall -- byte for byte what the
 * unbounded `ORDER BY ... LIMIT need` returns.
 *
 * THE EXTERNAL CONTRACT IS UNCHANGED, which is the whole reason for looping
 * here instead of handing back a short page and a "there might be more" token.
 * An account feed returning three events and asking the caller to try again
 * would be a worse answer than the slow one it replaces.
 */
export async function windowedRowRead<Row>(
  env: Env | null | undefined,
  options: WindowedRowReadOptions,
): Promise<Row[] | null> {
  const { table, columns, where, order, need, ceiling = null } = options;
  const query = options.query ?? r2SqlQuery;
  const select = (bound: string, limit: number) =>
    `SELECT ${columns} FROM ${table} WHERE ${where.join(" AND ")}${bound}` +
    `${order} LIMIT ${limit}`;

  const head = await startBlock(env, ceiling, options);
  if (head === null) {
    return (await query(env, select("", need))) as Row[] | null;
  }

  const collected: Row[] = [];
  let top: number | null = null;
  let window = ACCOUNT_EVENTS_BLOCK_WINDOW;
  for (
    let step = 0;
    step < MAX_WINDOW_STEPS && collected.length < need;
    step++
  ) {
    const floor = Math.max(0, (top ?? head) - window);
    // NO UPPER BOUND ON THE FIRST SLICE. The head is the decode watermark, and
    // a row can land in the lakehouse before the watermark advances past it --
    // so clamping the newest slice to `<= head` would drop exactly the rows
    // this feed exists to show first. The floor is what prunes; the ceiling
    // only matters from the second slice on, where it keeps the slices
    // disjoint so concatenation stays ordered.
    const slice = (await query(
      env,
      select(
        ` AND block_number >= ${floor}` +
          (top === null ? "" : ` AND block_number <= ${top}`),
        need - collected.length,
      ),
    )) as Row[] | null;
    // A failed slice fails the read. Returning what landed so far would publish
    // a page that is short for a reason the caller cannot see, which is the
    // silently-truncated answer this whole family declines rather than serves.
    if (slice === null) return null;
    collected.push(...slice);
    if (floor === 0) break;
    top = floor - 1;
    window *= WINDOW_GROWTH;
  }
  return collected;
}

export interface WindowedFloorReadOptions<T> extends WindowWalkDeps {
  /** The cursor's block, or null to start from the lakehouse head. */
  ceiling?: number | null;
  /**
   * Issue the read. Receives the `block_number` bound to splice into the SQL --
   * empty string when the read is unbounded.
   */
  attempt: (bound: string, query: R2SqlReader) => Promise<T | null>;
  /** Whether this attempt saw enough rows that widening cannot change it. */
  satisfied: (value: T) => boolean;
}

/**
 * ONE bounded attempt, then the unbounded read -- for an aggregate over "the
 * newest N events" whose ORDER BY and LIMIT must stay inside SQL.
 *
 * WHY NOT THE ACCUMULATING WALK. Each slice would aggregate EVERY row in its
 * range rather than only enough to reach N, so the totals would describe a wider
 * set than the published window and quietly change `scan_capped`, `first_seen`
 * and the counts. Re-issuing a bounded copy of the same ordered, limited query
 * is exact instead: the bound is `block_number >= floor` with no ceiling, so the
 * range is always a SUFFIX of the newest blocks, and the newest N rows within it
 * are the newest N overall as soon as it holds N of them.
 *
 * WHY NOT WIDEN REPEATEDLY, WHICH IS WHAT THE FEED WALK DOES. Because for this
 * question widening cannot pay. An account with fewer than N events in the whole
 * chain is only PROVEN to have fewer by reading its whole history -- the last
 * window is `block_number >= 0`, which prunes nothing. Walking would then charge
 * three extra queries for the same full scan it was trying to avoid.
 *
 * So this is deliberately two-phase, and strictly better than the unbounded read
 * it replaces in both directions:
 *
 *   - a high-activity account fills N inside the first window and never issues
 *     the full scan. Those are exactly the accounts #9386 measured declining
 *     ~50% of the time, and the first window is ~5,800x cheaper.
 *   - a low-activity account pays ONE extra small query and then the same read
 *     it always did. It cannot get slower by more than that window.
 */
export async function windowedFloorRead<T>(
  env: Env | null | undefined,
  options: WindowedFloorReadOptions<T>,
): Promise<T | null> {
  const { ceiling = null, attempt, satisfied } = options;
  const query = options.query ?? r2SqlQuery;

  const head = await startBlock(env, ceiling, options);
  if (head === null) return attempt("", query);

  const floor = Math.max(0, head - ACCOUNT_EVENTS_BLOCK_WINDOW);
  // A head inside the first window means the bound IS the whole table; issuing
  // it would be one wasted query before the identical unbounded read.
  if (floor > 0) {
    const bounded = await attempt(` AND block_number >= ${floor}`, query);
    if (bounded === null) return null;
    if (satisfied(bounded)) return bounded;
  }
  return attempt("", query);
}
