// The D1 -> Neon reconciler for the two ACCUMULATING daily tables (infra#336).
//
// ## Why the mirror alone does not finish the job
//
// #9712/#9729/#9733/#9739 mirror every write into Neon, which is enough for the
// five LATEST-ONLY tables: `neurons`, `nominator_positions` and the three flat
// ledgers are fully rewritten each producer cycle, so one cycle after the
// mirror turns on the two stores agree. Measured, `neurons` matched D1 exactly
// on the first pass -- 129 netuids, 30,109 rows, identical SUM(uid).
//
// `neuron_daily` and `account_position_daily` accumulate by date and are never
// rewritten, so a mirror can only ever cover the days it was running for.
// Measured 2026-08-07 with the mirror healthy and current:
//
//     neuron_daily            D1 846,912   NEON  30,109   (today, and nothing else)
//     account_position_daily  D1 834,081   NEON 833,849
//
// ## Why this is a reconciler and not a script
//
// A script closes that gap once. It does not close it the next time a mirror
// write fails mid-chunk, a lane is turned off and back on, or a deploy lands
// between two halves of a producer cycle. And until this file existed nothing
// in the system compared the two stores AT ALL -- which is the blind spot that
// let a frozen Neon serve `GET /api/v1/accounts/{ss58}/subnets/{netuid}/history`
// for two days without a single failing check (#9705).
//
// So the deficit is recomputed from both sides every tick. When there is
// nothing missing this is a no-op costing one grouped count per store, and it
// stays wired afterwards as the consistency check the pilot never had.
//
// ## The deficit IS the cursor
//
// There is no stored progress and no state table. Each tick asks both stores
// for their per-date row counts and copies the newest date where Neon has fewer
// rows than D1. An interrupted tick, a redeploy mid-copy, and two ticks
// overlapping all resolve to the same place, because the only state is the data
// itself. That is also why the unit of work is a WHOLE DATE: stopping halfway
// through one would leave a deficit the next tick recomputes correctly but
// restarts, so the budget is checked between dates rather than inside one.
//
// ## Newest date first
//
// Both tables are read as "the last N days", so copying backwards from today
// makes the served window correct progressively rather than all at once at the
// end. If this never finishes, what it did finish is the part anything asks
// for.

import {
  neonBackfillLanes,
  writeRowsToNeon,
  type NeonWriteResult,
  type PgUnsafe,
} from "./neon-write.ts";
import {
  ACCOUNT_POSITION_DAILY_COLUMNS,
  NEURON_DAILY_COLUMNS,
} from "./neurons-d1-write.ts";
import {
  createPgSql,
  type HyperdriveLike,
  type WaitUntilLike,
} from "./pg-sql.ts";
import {
  loadLatestLaneHealth,
  recordLaneVerdict,
  type LaneHealthDb,
} from "./lane-health.ts";

type Row = Record<string, unknown>;

/** Rows read from D1 per page. Two thousand rows of the wider table is roughly
 * a megabyte of JSON, which is a comfortable D1 response and a comfortable
 * slice to hold while the Neon statements for it are built. */
export const D1_PAGE_ROWS = 2_000;

/** Hard ceiling on dates copied per tick, whatever the clock says. A cap the
 * budget cannot override keeps one tick's cost predictable when a date turns
 * out to be far smaller than the ~32,000 rows these tables average. */
export const MAX_DATES_PER_TICK = 4;

/** Wall-clock budget, checked BETWEEN dates. Cron ticks here are 3 minutes
 * apart, so finishing well inside one leaves the next tick a clean start
 * rather than an overlap. */
export const TICK_BUDGET_MS = 20_000;

/** How long a clean verdict suppresses the next comparison.
 *
 * The comparison is two grouped counts over ~840,000 rows each. During the
 * backfill that cost is worth paying every tick; once the stores agree it is
 * ~600M D1 rows read a month to re-learn the same thing. So a lane that just
 * reported no deficit skips the comparison until this much time has passed,
 * which turns a 3-minute reconciler into an hourly one exactly when it becomes
 * a watchdog rather than a copier. */
export const IDLE_RECHECK_MS = 60 * 60 * 1000;

/** The minimal D1 surface this needs, so a test can hand it a fake. */
export interface BackfillDb {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all(): Promise<{ results?: unknown[] } | null>;
    };
    all(): Promise<{ results?: unknown[] } | null>;
  };
}

export interface BackfillPlan {
  table: string;
  columns: readonly string[];
  /** Neon's primary key. Matches D1's, which is why one row shape serves both. */
  conflict: readonly string[];
  /** The primary key MINUS snapshot_date, in key order: the columns a page
   * within one date resumes from. */
  keyset: readonly string[];
  /** Columns D1 stores as 0/1 and Neon declares BOOLEAN.
   *
   * NOT a stylistic difference -- it is the one shape mismatch between the two
   * stores, and it has already caused an outage in this lane. The rows the
   * live mirror sends carry real JS booleans (the bit conversion lives in
   * SQLite's implicit binding, not in the shared row shaping), so Neon's
   * columns are BOOLEAN and its writes succeed. Rows read BACK out of D1 are
   * integers, so this path -- and only this path -- has to convert them. */
  booleans: readonly string[];
}

/**
 * One plan per table, keyed by the name used in NEON_BACKFILL_LANES.
 *
 * The conflict keys are D1's declared PRIMARY KEYs, read off sqlite_master
 * 2026-08-07 rather than assumed, and they match Neon's. An ON CONFLICT naming
 * columns with no unique index behind them is a runtime error, not a slower
 * query.
 */
export const NEON_BACKFILL_PLANS: Readonly<Record<string, BackfillPlan>> = {
  neuron_daily: {
    table: "neuron_daily",
    columns: NEURON_DAILY_COLUMNS,
    conflict: ["netuid", "uid", "snapshot_date"],
    keyset: ["netuid", "uid"],
    booleans: ["active", "validator_permit", "is_immunity_period"],
  },
  account_position_daily: {
    table: "account_position_daily",
    columns: ACCOUNT_POSITION_DAILY_COLUMNS,
    conflict: ["account", "netuid", "snapshot_date"],
    keyset: ["account", "netuid"],
    booleans: ["active", "validator_permit"],
  },
};

/**
 * The guard every backfill write carries.
 *
 * Without it this path can REGRESS live data. Today's rows are rewritten by
 * the producer all day, so a page read from D1 at 12:00 and written to Neon at
 * 12:01 would overwrite whatever the mirror wrote at 12:00:30. With it, an
 * older `captured_at` is a no-op and the newer row stands.
 */
export function backfillGuard(table: string): string {
  return `${table}.captured_at < EXCLUDED.captured_at`;
}

/**
 * The keyset predicate for resuming a page, as SQL plus its bind values.
 *
 * Expanded rather than written as a row-value comparison -- `(a, b) > (?, ?)`
 * is valid SQLite but the expanded form is what the (snapshot_date, a, b)
 * index seeks on unambiguously, and this query's whole cost model depends on
 * that index being used.
 */
export function keysetPredicate(
  keyset: readonly string[],
  cursor: readonly unknown[],
): { sql: string; values: unknown[] } {
  const terms: string[] = [];
  const values: unknown[] = [];
  for (let i = 0; i < keyset.length; i += 1) {
    const equals = keyset.slice(0, i).map((column) => `${column} = ?`);
    terms.push([...equals, `${keyset[i]} > ?`].join(" AND "));
    values.push(...cursor.slice(0, i), cursor[i]);
  }
  return { sql: `(${terms.map((term) => `(${term})`).join(" OR ")})`, values };
}

/** Per-date row counts from D1, as a map of snapshot_date to count. */
export async function d1DateCounts(
  db: BackfillDb | null | undefined,
  table: string,
): Promise<Map<string, number> | null> {
  try {
    const result = await db
      ?.prepare(
        `SELECT snapshot_date AS d, COUNT(*) AS n FROM ${table} GROUP BY snapshot_date`,
      )
      .all();
    if (!result) return null;
    return countMap(result.results ?? [], "d", "n");
  } catch {
    // Null, never an empty map: "D1 did not answer" and "D1 has no rows" would
    // otherwise both read as a deficit of everything Neon holds, and the second
    // one is the shape of a catastrophic mistaken copy.
    return null;
  }
}

/** Per-date row counts from Neon, in the same shape. */
export async function neonDateCounts(
  sql: PgUnsafe | null | undefined,
  table: string,
): Promise<Map<string, number> | null> {
  if (!sql?.unsafe) return null;
  try {
    const rows = (await sql.unsafe(
      `SELECT snapshot_date::text AS d, COUNT(*) AS n FROM ${table} GROUP BY snapshot_date`,
    )) as unknown[];
    return countMap(Array.isArray(rows) ? rows : [], "d", "n");
  } catch {
    return null;
  }
}

function countMap(
  rows: readonly unknown[],
  dateKey: string,
  countKey: string,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const raw of rows) {
    const row = raw as Row;
    const date = row?.[dateKey];
    if (date == null) continue;
    const n = Number(row[countKey]);
    out.set(String(date), Number.isFinite(n) ? n : 0);
  }
  return out;
}

export interface DateDeficit {
  date: string;
  d1: number;
  neon: number;
}

/**
 * Dates where Neon holds fewer rows than D1, NEWEST FIRST.
 *
 * Strictly `neon < d1`. A date where Neon holds MORE is not reported and not
 * acted on: this path only ever adds rows, and a surplus in Neon is a question
 * about deletes that copying cannot answer and must not paper over.
 */
export function dateDeficits(
  d1Counts: ReadonlyMap<string, number>,
  neonCounts: ReadonlyMap<string, number>,
): DateDeficit[] {
  const out: DateDeficit[] = [];
  for (const [date, d1] of d1Counts) {
    const neon = neonCounts.get(date) ?? 0;
    if (neon < d1) out.push({ date, d1, neon });
  }
  // ISO dates sort lexicographically, so `localeCompare` reversed is the whole
  // ordering -- and the keys came from a Map, so there are no ties to break.
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

/** D1's integers where Neon declares BOOLEAN, and nothing else touched. */
export function shapeRowForNeon(row: Row, booleans: readonly string[]): Row {
  const out: Row = { ...row };
  for (const column of booleans) {
    const value = out[column];
    if (value != null) out[column] = Boolean(value);
  }
  return out;
}

/** One page of a date's rows from D1, in keyset order. */
export async function readDatePage(
  db: BackfillDb,
  plan: BackfillPlan,
  date: string,
  cursor: readonly unknown[] | null,
  limit: number,
): Promise<Row[]> {
  const keyset = cursor ? keysetPredicate(plan.keyset, cursor) : null;
  const sql =
    `SELECT ${plan.columns.join(", ")} FROM ${plan.table} ` +
    `WHERE snapshot_date = ?${keyset ? ` AND ${keyset.sql}` : ""} ` +
    `ORDER BY ${plan.keyset.join(", ")} LIMIT ?`;
  const result = await db
    .prepare(sql)
    .bind(date, ...(keyset?.values ?? []), limit)
    .all();
  return (result?.results ?? []) as Row[];
}

export interface DateCopyResult extends NeonWriteResult {
  date: string;
  pages: number;
}

/**
 * Copy one date, page by page, until D1 returns a short page.
 *
 * Stops at the first failed write rather than continuing to the next page, for
 * the same reason `writeRowsToNeon` stops at the first failed chunk: continuing
 * past a failure produces a row count that looks nearly complete over a table
 * that is not.
 */
export async function copyDateToNeon(
  db: BackfillDb,
  sql: PgUnsafe,
  plan: BackfillPlan,
  date: string,
  pageRows: number = D1_PAGE_ROWS,
): Promise<DateCopyResult> {
  let cursor: unknown[] | null = null;
  let rows = 0;
  let statements = 0;
  let pages = 0;
  for (;;) {
    let page: Row[];
    try {
      page = await readDatePage(db, plan, date, cursor, pageRows);
    } catch (error) {
      return {
        ok: false,
        rows,
        statements,
        pages,
        date,
        reason: reason(error),
      };
    }
    if (page.length === 0) return { ok: true, rows, statements, pages, date };
    pages += 1;
    const result = await writeRowsToNeon(
      sql,
      plan.table,
      plan.columns,
      page.map((row) => shapeRowForNeon(row, plan.booleans)),
      plan.conflict,
      backfillGuard(plan.table),
    );
    rows += result.rows;
    statements += result.statements;
    if (!result.ok) {
      return {
        ok: false,
        rows,
        statements,
        pages,
        date,
        reason: result.reason,
      };
    }
    if (page.length < pageRows)
      return { ok: true, rows, statements, pages, date };
    const last = page[page.length - 1];
    cursor = plan.keyset.map((column) => last[column]);
  }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface BackfillTableOutcome {
  table: string;
  /** Deficient dates found this tick, before any were copied. */
  deficits: number;
  /** Rows still missing across all deficient dates, before any were copied. */
  missing: number;
  /**
   * Rows still missing over the dates this tick did NOT reach.
   *
   * NOT `missing - rowsCopied`, which is the wrong subtraction and goes
   * negative in the ordinary case. The unit of work is a whole DATE, so
   * copying a date 231 rows short writes all 30,278 of its rows -- the upsert
   * makes the other 30,047 no-ops. Reporting "-30,047 rows still behind" is
   * how that first showed up in production.
   */
  remaining: number;
  copied: DateCopyResult[];
  ok: boolean;
  reason?: string;
  /** True when the comparison was skipped because a clean verdict is recent. */
  skipped?: boolean;
}

export interface BackfillDeps {
  sql?: PgUnsafe | null;
  db?: BackfillDb | null;
  laneHealthDb?: LaneHealthDb | null;
  now?: () => number;
  /** Injectable so a test can drive the budget without waiting on a clock. */
  elapsed?: () => number;
}

/**
 * Reconcile one table. Never throws.
 *
 * The verdict is `stale` whenever a deficit remains after this tick, including
 * the tick that found one and copied it successfully -- because "there is still
 * a gap" is the thing a reader of `lane_health` needs to know, and a verdict of
 * `ok` on a tick that copied 4 of 26 missing dates would report progress as
 * completion. #9698's alarm escalates a lane that stays stale, which during a
 * backfill is exactly the signal that it has stopped converging.
 */
export async function reconcileTableToNeon(
  db: BackfillDb | null | undefined,
  sql: PgUnsafe | null | undefined,
  plan: BackfillPlan,
  deps: BackfillDeps = {},
): Promise<BackfillTableOutcome> {
  const table = plan.table;
  const base = {
    table,
    deficits: 0,
    missing: 0,
    remaining: 0,
    copied: [] as DateCopyResult[],
  };
  if (!db?.prepare || !sql?.unsafe) {
    return { ...base, ok: false, reason: "unbound" };
  }
  const [d1Counts, neonCounts] = await Promise.all([
    d1DateCounts(db, table),
    neonDateCounts(sql, table),
  ]);
  if (!d1Counts || !neonCounts) {
    // A store that would not answer is NOT a deficit of everything the other
    // holds. Refusing to act on a half-read comparison is the whole reason
    // both counters return null rather than an empty map.
    return {
      ...base,
      ok: false,
      reason: `count failed: ${!d1Counts ? "d1" : "neon"}`,
    };
  }
  const deficits = dateDeficits(d1Counts, neonCounts);
  const missing = deficits.reduce((sum, d) => sum + (d.d1 - d.neon), 0);
  if (deficits.length === 0) return { ...base, ok: true };

  const elapsed = deps.elapsed ?? (() => 0);
  const copied: DateCopyResult[] = [];
  // Rows still owed, counted over the dates this tick did NOT reach. Each
  // date's own deficit comes off as that date completes, so the figure never
  // depends on how many rows were WRITTEN -- copying a whole date to close a
  // 231-row gap writes 30,278 rows, and subtracting those would report a
  // negative backlog.
  let remaining = missing;
  for (const deficit of deficits.slice(0, MAX_DATES_PER_TICK)) {
    if (copied.length > 0 && elapsed() >= TICK_BUDGET_MS) break;
    const result = await copyDateToNeon(db, sql, plan, deficit.date);
    copied.push(result);
    if (!result.ok) {
      return {
        table,
        deficits: deficits.length,
        missing,
        remaining,
        copied,
        ok: false,
        reason: result.reason,
      };
    }
    remaining -= deficit.d1 - deficit.neon;
  }
  return {
    table,
    deficits: deficits.length,
    missing,
    remaining,
    copied,
    ok: true,
  };
}

/** One line per table, for the lane verdict's detail column. */
export function describeOutcome(outcome: BackfillTableOutcome): string {
  if (outcome.skipped) return "no deficit at last check";
  if (!outcome.ok) {
    const rows = outcome.copied.reduce((sum, c) => sum + c.rows, 0);
    return `${rows} row(s) copied before failure: ${outcome.reason ?? "unknown"}`;
  }
  if (outcome.deficits === 0) return "in sync";
  const rows = outcome.copied.reduce((sum, c) => sum + c.rows, 0);
  const dates = outcome.deficits - outcome.copied.length;
  // `remaining` counts the dates NOT reached, not `missing - rows`. Rows
  // written and rows owed are different quantities: a date 231 rows short is
  // closed by writing all 30,278 of its rows.
  return (
    `${rows} row(s) over ${outcome.copied.length} date(s); ` +
    `${dates} date(s) / ${outcome.remaining} row(s) still behind`
  );
}

export interface BackfillOutcome {
  attempted: boolean;
  tables: BackfillTableOutcome[];
}

/**
 * Run the reconciler for every table named in NEON_BACKFILL_LANES.
 *
 * Never throws: this is a cron lane behind no request, and a fault here must
 * cost a verdict rather than a tick.
 */
export async function runNeonBackfill(
  env: Record<string, unknown> | null | undefined,
  ctx: WaitUntilLike | null | undefined,
  deps: BackfillDeps = {},
): Promise<BackfillOutcome> {
  const lanes = neonBackfillLanes(env);
  if (lanes.size === 0) return { attempted: false, tables: [] };

  const hyperdrive = env?.HYPERDRIVE as HyperdriveLike | undefined;
  const sql =
    deps.sql ??
    (hyperdrive?.connectionString && ctx ? createPgSql(hyperdrive, ctx) : null);
  const db = deps.db ?? (env?.METAGRAPH_HEALTH_DB as BackfillDb | undefined);
  const laneDb =
    deps.laneHealthDb ?? (env?.METAGRAPH_HEALTH_DB as LaneHealthDb | undefined);
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const elapsed = deps.elapsed ?? (() => now() - startedAt);

  const latest = await loadLatestLaneHealth(laneDb);
  const tables: BackfillTableOutcome[] = [];
  for (const lane of lanes) {
    const plan = NEON_BACKFILL_PLANS[lane];
    // An unknown lane is a no-op rather than a throw: the flag is a free-text
    // list and a typo must not take down the tick for the lanes spelled right.
    if (!plan) continue;

    const previous = latest[`neon:backfill:${lane}`];
    if (
      previous?.verdict === "ok" &&
      now() - previous.checked_at < IDLE_RECHECK_MS
    ) {
      tables.push({
        table: plan.table,
        deficits: 0,
        missing: 0,
        remaining: 0,
        copied: [],
        ok: true,
        skipped: true,
      });
      continue;
    }

    let outcome: BackfillTableOutcome;
    try {
      outcome = await reconcileTableToNeon(db, sql, plan, { elapsed });
    } catch (error) {
      outcome = {
        table: plan.table,
        deficits: 0,
        missing: 0,
        remaining: 0,
        copied: [],
        ok: false,
        reason: reason(error),
      };
    }
    tables.push(outcome);
    // `ok` ONLY when the comparison itself found nothing missing -- never on
    // the tick that copied the last date. A copy reports what it wrote, not
    // what is now true, so the tick after the final one re-counts both stores
    // and is what actually declares them equal. That is one extra tick and it
    // is the difference between "we sent the rows" and "they are there".
    const settled = outcome.ok && outcome.deficits === 0;
    await recordLaneVerdict(laneDb, {
      lane: `neon:backfill:${lane}`,
      verdict: settled ? "ok" : "stale",
      age_ms: null,
      detail: describeOutcome(outcome),
      checked_at: now(),
    });
  }
  return { attempted: true, tables };
}
