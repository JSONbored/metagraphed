// The alarm for a hole in the MIDDLE of a daily series (#9781).
//
// ## The gap freshness cannot see
//
// Every existing watchdog here asks how old the newest row is. That question is
// structurally blind to a missing day: a rollup that skips 08-06 and runs
// normally on 08-07 has a newest row minutes old, a full width, and a hole in
// its history that no freshness check can express.
//
// It happened, and it went unnoticed until someone queried by hand:
//
//   neuron_daily                          account_position_daily
//   2026-08-07  30118 rows, 129 netuids   2026-08-07  30946 rows
//               <-- 08-06 absent -->                  <-- 08-06 absent -->
//   2026-08-05  30104 rows, 129 netuids   2026-08-05  31091 rows
//
// Both tables, the same single day, every other day back to 07-29 present at
// full width. `neuron_daily` is the history source and it is only ~26 days
// deep, so a missed day ages out of any recomputable window and becomes
// permanent. The cost of not noticing is not "a late alert", it is the data.
//
// ## Two faults, deliberately distinguished
//
// MISSING is a date with no rows between the oldest and newest the table holds.
// THIN is a date present at a small fraction of the median width -- a pass that
// started and died partway, which reads as a normal day to anything counting
// dates rather than rows. They send whoever reads the alert to different
// places, so they are separate reasons rather than one "incomplete".
//
// ## Why the boundary dates are excluded
//
// The newest date is almost always in progress -- a rollup writing right now is
// thin by definition and will be full within the hour. Alarming on it would
// fire every single day, and an alarm that fires on a working lane stops being
// read (#9301). The oldest is excluded for the mirror reason: retention prunes
// from that end, so the oldest day is legitimately a partial remnant.
//
// The cost is honest and bounded: a hole on the newest day is caught one day
// late. Freshness already covers that end, which is the half this is not.
import { laneHealthStore } from "./lane-health-store.ts";
import { recordLaneVerdict, type LaneHealthDb } from "./lane-health.ts";
import { readStore } from "./read-store.ts";
import { recordExceptionEvent } from "./usage-telemetry.ts";

export const DAILY_COVERAGE_LANE = "daily-series-coverage";

/**
 * The series this covers, and the column each dates its rows by.
 *
 * Hand-listed rather than discovered from the schema. Ten tables carry a daily
 * date column and only these are SERIES -- a continuous record where a missing
 * day is a hole. `api_key_usage_daily` and `api_quota_daily` have rows only on
 * days with traffic, so a gap there is a quiet Tuesday, and alarming on it
 * would be the #9301 failure by construction.
 */
export const DAILY_SERIES: readonly { table: string; column: string }[] = [
  { table: "neuron_daily", column: "snapshot_date" },
  { table: "account_position_daily", column: "snapshot_date" },
];

/**
 * How far below the median a present day may fall before it is THIN.
 *
 * A third. Wide enough that ordinary day-to-day variation -- subnets
 * registering, UIDs churning -- never trips it, narrow enough to catch the
 * failure this pairs with: a pass that died partway leaves a fraction of a
 * normal day, not 70% of one. Measured against the MEDIAN rather than the mean
 * so the thin day cannot drag its own threshold down.
 */
export const DAILY_THIN_RATIO = 1 / 3;

/**
 * How far back from the NEWEST date the walk goes.
 *
 * ~26 days of history today; 90 covers any retention change without asking the
 * store for the whole table.
 *
 * ANCHORED TO THE NEWEST DATE, NOT TO THE OLDEST ROW, and that is not a
 * micro-optimisation. Run against production this found `neuron_daily: missing
 * 2026-08-06` -- correct -- and then `account_position_daily` missing every day
 * from 1970-01-22 onward, because one row there carries a `captured_at` written
 * in SECONDS and is stranded in 1970 (#9782). Walking oldest-to-newest made the
 * interior 56 years wide and produced a 221 KB verdict naming 20,000 dates.
 *
 * A single corrupt row must not be able to do that. Anchoring to the newest
 * date bounds the walk at 90 entries whatever the oldest row claims, and leaves
 * the stranded row to the issue that is actually about it.
 */
export const DAILY_COVERAGE_LOOKBACK_DAYS = 90;

/**
 * How many dates a verdict names before it summarises.
 *
 * `lane_health.detail` is read by a human deciding where to look, and thirty
 * dates is already past the point where one more helps. The count is always
 * exact even when the list is truncated -- "and 4 more" is information, a
 * silently shortened list is not.
 */
export const DAILY_COVERAGE_MAX_LISTED = 12;

export interface DailySeriesDay {
  date: string;
  rows: number;
}

export interface DailySeriesVerdict {
  table: string;
  /** Dates with no rows at all, between the oldest and newest held. */
  missing: string[];
  /** Dates present but far below the median width. */
  thin: string[];
  /** Days examined, excluding the two boundaries. */
  examined: number;
  median_rows: number;
}

/** UTC date arithmetic on YYYY-MM-DD, with no timezone anywhere near it. */
function addDays(date: string, days: number): string {
  const ms = Date.parse(`${date}T00:00:00Z`);
  return new Date(ms + days * 86_400_000).toISOString().slice(0, 10);
}

function nextDate(date: string): string {
  return addDays(date, 1);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
    : sorted[mid]!;
}

/**
 * The rule alone, testable without a database or a clock.
 *
 * Takes the days a table actually holds and returns the holes. Walking the
 * calendar between the observed ends rather than from "today" is what makes
 * this independent of when it runs -- and of whether today's rollup has
 * happened yet, which is the freshness question this is deliberately not
 * asking.
 */
export function evaluateDailyCoverage(
  table: string,
  days: readonly DailySeriesDay[],
  thinRatio = DAILY_THIN_RATIO,
  lookbackDays = DAILY_COVERAGE_LOOKBACK_DAYS,
): DailySeriesVerdict {
  const empty = { table, missing: [], thin: [], examined: 0, median_rows: 0 };
  if (days.length < 3) {
    // Two days cannot have a hole between them, and one cannot have a median.
    // Reporting "no gaps" over a table too short to have one would be a green
    // light that means nothing.
    return empty;
  }
  const byDate = new Map(days.map((d) => [d.date, d.rows]));
  const dates = [...byDate.keys()].sort();
  const newest = dates[dates.length - 1]!;
  // The floor is the LATER of the oldest row and the lookback, so one row with
  // a corrupt date cannot widen the walk (see the constant's note on #9782).
  const horizon = addDays(newest, -lookbackDays);
  const oldest = dates.find((date) => date >= horizon) ?? newest;

  const interior: string[] = [];
  for (let date = nextDate(oldest); date < newest; date = nextDate(date)) {
    interior.push(date);
  }
  // The median is taken over PRESENT interior days, so a run of missing dates
  // cannot pull the width threshold toward zero and hide the thin ones.
  const widths = interior
    .map((date) => byDate.get(date))
    .filter((rows): rows is number => typeof rows === "number" && rows > 0);
  const med = median(widths);
  const floor = Math.floor(med * thinRatio);

  const missing: string[] = [];
  const thin: string[] = [];
  for (const date of interior) {
    const rows = byDate.get(date);
    if (rows === undefined || rows === 0) missing.push(date);
    else if (med > 0 && rows < floor) thin.push(date);
  }
  return {
    table,
    missing,
    thin,
    examined: interior.length,
    median_rows: med,
  };
}

/** The dates, capped -- but the COUNT is always exact, because a silently
 * shortened list is worse than a long one. */
function listDates(dates: readonly string[]): string {
  if (dates.length <= DAILY_COVERAGE_MAX_LISTED) return dates.join(",");
  const shown = dates.slice(0, DAILY_COVERAGE_MAX_LISTED).join(",");
  return `${shown} and ${dates.length - DAILY_COVERAGE_MAX_LISTED} more (${dates.length} total)`;
}

/** One line naming the dates, because "3 gaps" sends nobody anywhere. */
export function coverageDetail(
  verdicts: readonly DailySeriesVerdict[],
): string {
  const faults = verdicts.filter(
    (v) => v.missing.length > 0 || v.thin.length > 0,
  );
  if (faults.length === 0) {
    const examined = verdicts.reduce((sum, v) => sum + v.examined, 0);
    return `${verdicts.length} series, ${examined} interior day(s), no gaps`;
  }
  return faults
    .map((v) => {
      const parts: string[] = [];
      if (v.missing.length > 0) parts.push(`missing ${listDates(v.missing)}`);
      if (v.thin.length > 0) {
        parts.push(`thin ${listDates(v.thin)} (median ${v.median_rows})`);
      }
      return `${v.table}: ${parts.join("; ")}`;
    })
    .join(" | ");
}

export interface DailyCoverageDeps {
  laneHealthDb?: LaneHealthDb | null;
  now?: () => number;
  recordException?: typeof recordExceptionEvent;
}

/**
 * One tick.
 *
 * Returns a summary rather than throwing, matching the rest of the cron family.
 */
export async function runDailySeriesCoverageWatchdog(
  env: Record<string, unknown> | null | undefined,
  deps: DailyCoverageDeps = {},
): Promise<Record<string, unknown>> {
  const now = deps.now ?? Date.now;
  const record = deps.recordException ?? recordExceptionEvent;
  const db = readStore(
    env,
    DAILY_SERIES.map((s) => s.table),
  );
  if (!db?.query) return { ok: false, reason: "no store bound" };

  const verdicts: DailySeriesVerdict[] = [];
  try {
    for (const { table, column } of DAILY_SERIES) {
      // Grouped in the store rather than pulled row by row: these tables hold
      // ~30k rows a day and the answer is one integer per date.
      const result = await db.query(
        `SELECT ${column} AS date, COUNT(*) AS rows FROM ${table} ` +
          `GROUP BY ${column} ORDER BY ${column} DESC LIMIT ?`,
        [DAILY_COVERAGE_LOOKBACK_DAYS],
      );
      const days = result
        .map((row) => ({
          date: String(row.date ?? ""),
          rows: Number(row.rows ?? 0),
        }))
        .filter((d) => d.date !== "" && Number.isFinite(d.rows));
      verdicts.push(evaluateDailyCoverage(table, days));
    }
  } catch (err) {
    return {
      ok: false,
      reason: "query_failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const holed = verdicts.some((v) => v.missing.length > 0 || v.thin.length > 0);
  const detail = coverageDetail(verdicts);
  if (holed) {
    await record(env, {
      error: new Error(
        `daily series has a hole: ${detail} -- a missing day is invisible to every freshness check, ` +
          `and neuron_daily is only ~26 days deep, so it ages out of any recomputable window`,
      ),
      route: `watchdog:${DAILY_COVERAGE_LANE}`,
      errorCode: "daily_series_gap",
    }).catch(() => false);
  }
  await recordLaneVerdict(laneHealthStore(env, deps.laneHealthDb), {
    lane: DAILY_COVERAGE_LANE,
    verdict: holed ? "stale" : "ok",
    age_ms: null,
    detail,
    checked_at: now(),
  });
  return { ok: true, alerted: holed, verdicts };
}
