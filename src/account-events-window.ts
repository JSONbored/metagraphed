// Bounding the scan for reads that filter a SCATTERED key on
// `chain.account_events` (#11131).
//
// A hotkey/coldkey value is spread across every data file, so file statistics
// cannot prune on it and the engine opens all 48. The fix is a predicate on a
// column the statistics DO order. Which column, and how wide, are not details --
// they are the whole difference. MEASURED against production, 2026-08-14, one
// busy account, `(hotkey = X OR coldkey = X) ORDER BY observed_at DESC LIMIT 50`:
//
//   no bound                          1,933.6 MB   48 files   7,333 R2 requests
//   block_number >= head - 250,000      957.7 MB   37 files   4,947
//   observed_at  >= now - 2 days            2.9 MB  18 files      66
//
// TWO SEPARATE FACTS ARE IN THAT TABLE.
//
// 1. `observed_at` PRUNES AND `block_number` BARELY DOES. Over the same one-day
//    span: 60.2 MB via `block_number`, 0.6 MB via `observed_at` -- 100x for the
//    identical set of rows. The writer orders by observed_at, so file min/max is
//    tight on it and loose on block height.
// 2. THE WINDOW WAS ~18x TOO WIDE. 250,000 blocks is ~35 days. The pruning curve
//    is steep and nearly all of the win is in the first few days:
//
//      35 days   335.5 MB   35 files        1 day    0.9 MB   18 files
//       7 days    18.6 MB   19 files        6 hours  0.1 MB   15 files
//
// So the first window is 2 DAYS, and it is deliberately small: overshooting
// costs 100x the bytes, undershooting costs ONE extra query at ~0.6 MB. That
// asymmetry is the whole design.
//
// THE HARD PART IS NOT THE BOUND, IT IS KEEPING THE ANSWER. A cold-tier read
// here either answers exactly what the Postgres tier would or DECLINES -- a
// silently-truncated feed is the one outcome this family never produces. So the
// window cannot simply be "the last N days": an account whose last transfer was
// two years ago must still get that transfer, not an empty page. Everything
// below therefore PROBES a small window first and, if that does not fill the
// page, reads the whole remainder in one query -- never a truncated answer, and
// never more than two extra queries.
//
// WHY IT DOES NOT KEEP WIDENING. Because proving an account has nothing means
// reading its whole history, and a walk pays for that scan several times over in
// overlapping file reads. Measured on an account with no transfers, widening all
// the way down cost 8 queries / 3,834.3 MB / 81.3s against 3,035.7 MB for the
// single unbounded scan it replaced. See PROBE_STEPS.
//
// WHY THERE IS NO HEAD READ. The previous shape resolved the lakehouse head
// block before its first slice, which cost a query and a dependency. Slicing on
// observed_at removes both: the newest slice carries no upper bound, so it needs
// no anchor to be correct. `Date.now()` is only the FLOOR's reference, and the
// capture lane running behind it is harmless because the walk widens. It does
// run behind -- measured 2026-08-14, the newest `observed_at` in the table was
// ~24h old, which is exactly why the first window is 2 days and not 1.
//
// The precedent is `windowedAccountEventsRead`, which /accounts/{ss58}/events
// has used since #10190; this module is that function moved onto the column that
// actually prunes and generalised, so the transfer feed, the counterparty scans
// and the summary card share one bound instead of one route having it.
import { r2SqlQuery } from "./r2-sql.ts";
import type { R2SqlReader } from "./r2-sql.ts";
import type { R2SqlEnv } from "./r2-sql.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The first window, in milliseconds of `observed_at`.
 *
 * Two days, measured: it fills a 50-row page for a busy account in ONE query at
 * 2.9 MB / 18 files / 66 R2 requests. One day returns ~7 rows, because the
 * capture lane runs about a day behind wall clock; four days costs 7.7 MB for
 * the same page.
 */
export const ACCOUNT_EVENTS_WINDOW_MS = 2 * DAY_MS;

/**
 * Each step multiplies the window rather than adding to it, so a genuinely old
 * account is reached in a handful of queries instead of hundreds: 2, 8, 32, 128,
 * 512, 2048 days.
 */
export const WINDOW_GROWTH = 4;

/**
 * How many bounded PROBES to issue before giving up and reading the rest in one
 * query. Two: `now-2d`, then `now-8d`.
 *
 * MEASURED, and this number is the whole difference between a fix and a
 * regression. An account with no matching rows can only be PROVEN empty by
 * reading its whole history, so a walk that keeps widening pays for that scan
 * several times over in overlapping file reads. Walking all the way down for a
 * zero-transfer account cost:
 *
 *   2d 3.0MB · 8d 18.8MB · 32d 607.2MB · 128d 1,263.8MB · 512d 1,265.3MB
 *   -> 8 queries, 3,834.3 MB, 81.3 seconds
 *
 * against 3,035.7 MB for the single unbounded scan it replaced. The cost curve
 * turns sharply after ~8 days -- 18.8 MB at 8 days, 607 MB at 32 -- so probing
 * past that buys nothing a full read would not do more cheaply.
 *
 * Two probes cost ~22 MB. An account with activity in the last 8 days (the
 * overwhelming majority of reads anyone actually makes) answers from them at
 * 100-1000x less than before; one without pays that ~22 MB and then exactly the
 * read it always did. Strictly better in both directions, which is the property
 * worth having.
 */
export const PROBE_STEPS = 2;

export interface WindowWalkDeps {
  /** Defaults to the real r2-sql reader. */
  query?: R2SqlReader;
  /** Defaults to `Date.now`, injected so tests pin the window arithmetic. */
  now?: () => number;
}

/**
 * The `observed_at` predicate for one step.
 *
 * The NEWEST slice carries no upper bound, and both reasons matter: the capture
 * lane writes behind wall clock, so a ceiling anchored on "now" would exclude
 * the rows a newest-first feed exists to show; and without a ceiling the range
 * is a SUFFIX of the table, which is what makes "the newest N within the range"
 * mean "the newest N overall".
 */
function windowBound(floor: number, ceiling: number | null): string {
  return (
    ` AND observed_at >= ${Math.max(0, Math.trunc(floor))}` +
    (ceiling === null ? "" : ` AND observed_at <= ${Math.trunc(ceiling)}`)
  );
}

export interface WindowedRowReadOptions extends WindowWalkDeps {
  /** Fully-qualified table, e.g. `chain.account_events`. */
  table: string;
  /** The SELECT list, already joined. */
  columns: string;
  /** Predicates ANDed together; the window bound is added to them. */
  where: readonly string[];
  /** The ORDER BY clause, leading space included by the caller's constant. */
  order: string;
  /** How many rows the caller needs before it can stop. */
  need: number;
  /**
   * A cursor page's `observed_at`, so the walk resumes from there rather than
   * from now. Null starts at the newest end.
   */
  ceiling?: number | null;
  /**
   * The projection's lower bound, when the caller already pushed one into
   * `where`. Null when it could not supply one.
   *
   * PASSED SEPARATELY rather than parsed back out of `where`, which is an
   * opaque string array by design. The walk cannot otherwise know that the
   * range it is about to read is empty -- and it was reading it anyway.
   */
  floorMs?: number | null;
}

/**
 * Read newest-first: probe a small `observed_at` window, then read the whole
 * remainder in one query if the page has not filled.
 *
 * WHY THE SLICES ARE DISJOINT RATHER THAN NESTED. Each step reads only below the
 * last one, so the total scanned is the UNION of the ranges rather than the sum
 * of prefixes, and no row can be returned twice.
 *
 * EXACTNESS. The slice column is the PRIMARY SORT COLUMN, which is what makes
 * the concatenation sound: every range is a suffix of the newest rows, the
 * ranges tile that suffix without gaps or overlap, and rows arrive ordered
 * within each slice -- so concatenating them yields the ordered rows of the
 * union. Stopping once `need` rows are in hand gives the newest `need` overall,
 * byte for byte what the unbounded `ORDER BY ... LIMIT need` returns. (The
 * previous shape sliced on `block_number` while ordering by `observed_at`, which
 * is only sound for as long as the two agree.)
 *
 * THE EXTERNAL CONTRACT IS UNCHANGED, which is the whole reason for looping here
 * instead of handing back a short page and a "there might be more" token. An
 * account feed returning three events and asking the caller to try again would
 * be a worse answer than the slow one it replaces.
 */
export async function windowedRowRead<Row>(
  env: R2SqlEnv | null | undefined,
  options: WindowedRowReadOptions,
): Promise<Row[] | null> {
  const {
    table,
    columns,
    where,
    order,
    need,
    ceiling = null,
    floorMs = null,
  } = options;
  const query = options.query ?? r2SqlQuery;
  const now = options.now ?? Date.now;

  const collected: Row[] = [];
  const read = async (bound: string): Promise<Row[] | null> =>
    (await query(
      env,
      `SELECT ${columns} FROM ${table} WHERE ${where.join(" AND ")}${bound}` +
        `${order} LIMIT ${need - collected.length}`,
    )) as Row[] | null;

  // The BOTTOM of the walk, and it is the projection's floor when there is one.
  //
  // Measured 2026-08-16 on 5EEmaGFE...5oM3qDSC, whose whole folded history is a
  // single event on 2026-08-11: the two probes cover ten days, so they already
  // spanned everything the account can have -- and the walk then issued a THIRD
  // query for `observed_at <= now - 10d`, against a `where` that also carries
  // `observed_at >= 2026-08-11`. Floor above ceiling: a range that cannot hold
  // a row, read at full R2 SQL latency, on every request.
  //
  // Zero when there is no floor, which is exactly the behaviour before this:
  // `Math.max(0, ...)` was already the bottom and `floor === 0` already ended
  // the walk.
  const bottom = floorMs === null ? 0 : Math.trunc(floorMs);

  let top: number | null = ceiling;
  let window = ACCOUNT_EVENTS_WINDOW_MS;
  for (let step = 0; step < PROBE_STEPS && collected.length < need; step++) {
    const floor = Math.max(bottom, (top ?? now()) - window);
    const slice = await read(windowBound(floor, top));
    // A failed slice fails the read. Returning what landed so far would publish
    // a page that is short for a reason the caller cannot see, which is the
    // silently-truncated answer this whole family declines rather than serves.
    if (slice === null) return null;
    collected.push(...slice);
    // THE WHOLE RANGE IS NOW READ. A window whose floor reached the bottom
    // covers everything at or above it, and the caller's own predicate excludes
    // everything below -- so a short page here is the complete answer, not an
    // unfinished one. Widening cannot find a row and neither can the tail read.
    if (floor <= bottom) return collected;
    top = floor - 1;
    window *= WINDOW_GROWTH;
  }
  if (collected.length >= need) return collected;

  // The probes did not fill the page, so read everything BELOW them in one
  // query rather than widening again. `observed_at <= top` keeps it disjoint
  // from what the probes already returned, so the concatenation stays ordered
  // and nothing is counted twice -- and it prunes nothing the probes had not
  // already excluded, which is precisely why widening further cannot pay.
  const rest = await read(` AND observed_at <= ${Math.trunc(top as number)}`);
  if (rest === null) return null;
  collected.push(...rest);
  return collected;
}

export interface WindowedFloorReadOptions<T> extends WindowWalkDeps {
  /**
   * Issue the read for one window. Receives the `observed_at` bound to splice
   * into the SQL -- empty string when the read is unbounded.
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
 * is exact instead: the bound carries no ceiling, so the range is always a
 * SUFFIX of the newest rows, and the newest N within it are the newest N overall
 * as soon as it holds N of them.
 *
 * WHY NOT WIDEN REPEATEDLY, WHICH IS WHAT THE FEED WALK DOES. Because for this
 * question widening cannot pay. An account with fewer than N events in the whole
 * chain is only PROVEN to have fewer by reading its whole history, so the last
 * window is the whole table and walking would charge extra queries for the same
 * full scan.
 *
 * So this is deliberately two-phase, and strictly better than the unbounded read
 * it replaces in both directions. Measured on the summary card's grouped leg:
 * 2,801.6 MB across 48 files unbounded, against 12.4 MB across 18 for the first
 * window -- and a low-activity account pays that 12.4 MB once before the read it
 * always did.
 */
export async function windowedFloorRead<T>(
  env: R2SqlEnv | null | undefined,
  options: WindowedFloorReadOptions<T>,
): Promise<T | null> {
  const { attempt, satisfied } = options;
  const query = options.query ?? r2SqlQuery;
  const now = options.now ?? Date.now;

  const bounded = await attempt(
    windowBound(now() - ACCOUNT_EVENTS_WINDOW_MS, null),
    query,
  );
  if (bounded === null) return null;
  if (satisfied(bounded)) return bounded;
  return attempt("", query);
}
