// A lane that RUNS and produces nothing reads as healthy (#11226).
//
// The attribution sweep ran on schedule, wrote a row for all 128 subnets,
// reported `ok: true`, and produced nothing, for its entire life. Every
// watchdog in this repo said it was healthy, and none of them was wrong: they
// ask whether a lane RAN, and it ran.
//
//   TABLE_FRESHNESS            healthy -- rows were arriving on time
//   check-lane-status          healthy -- the producer completed every pass
//   the lane heartbeat         healthy -- it enqueued and consumed as designed
//
// #10818 is the instance. This is the class.
//
// ## The signal that was there the whole time
//
//   SELECT verdict, count(*), max(sources_checked)
//   FROM attribution_sweeps GROUP BY verdict;
//   --  no-sources | 128 | 0
//
// ONE verdict, 128 times, ZERO sources checked -- against a registry that
// publishes ~2,900 sweepable http(s) surfaces across those same 128 subnets.
// That is not a finding about the subnets. It is a contradiction between two
// things this repo publishes, and it was one query away from the day the lane
// shipped.
//
// ## Why this is a rule and not an alarm for the attribution sweep
//
// A per-lane alarm has to be remembered for each new lane, which is the failure
// TABLE_FRESHNESS's own header describes: per-lane watchdogs cover only the
// lanes somebody remembered. So a lane DECLARES what it produces and what a
// degenerate result of that would look like, and inherits the check.
//
// ## Two faults, and neither needs a threshold
//
// BARREN is the whole fleet collapsing onto the one verdict that means "I
// classified nothing". A classifying lane whose output is uniform is reporting
// a defect in itself far more often than a fact about the world, and the
// uniform-AND-null case needs no per-lane tuning to be alarming.
//
// IDLE is the lane's own work counter reading zero everywhere. `sources_checked
// = 0` on ONE subnet is legitimate and the schema says so -- a subnet that
// publishes no surface has not been searched, and must not read as "searched,
// found nothing". Zero across every row is a lane that never tried.
//
// They are separate because they send a reader to different places: BARREN is
// "the classifier is wrong", IDLE is "the input never arrived".
//
// ## What this deliberately does NOT do
//
// It does not alarm on a lane whose rows are merely SKEWED -- 127 of 128 on one
// verdict is a fact about the world often enough that a threshold there would
// fire on working lanes, which is how an alarm stops being read (#9301). Only
// total collapse onto the null verdict counts, which is a property no healthy
// classifier can have for long.
import { laneHealthStore } from "./lane-health-store.ts";
import { recordLaneVerdict, type LaneHealthDb } from "./lane-health.ts";
import {
  countOrZero,
  readStore,
  type UntypedRowQuerier,
} from "./read-store.ts";
import { recordExceptionEvent } from "./usage-telemetry.ts";

export const DEGENERATE_OUTPUT_LANE = "degenerate-output";

/**
 * One classifying lane, and what a degenerate result of it looks like.
 *
 * DECLARED BY THE LANE, not discovered. There is no way to tell from a schema
 * which TEXT column is a classification or which of its values means "nothing
 * found" -- `verdict` here happens to be named for it, and the next lane's
 * might be `status` with a null value of `skipped`. Guessing would produce a
 * check that is confidently wrong about lanes nobody reviewed, which is worse
 * than one that covers only lanes somebody declared.
 */
export interface ClassifyingLane {
  /** The table the lane writes its classification into. */
  table: string;
  /** The column holding it. */
  verdictColumn: string;
  /** The value that means "this pass classified nothing". */
  barren: string;
  /**
   * A counter whose fleet-wide maximum of zero means no work was attempted.
   *
   * Optional: a lane may classify without counting its inputs. When present it
   * is the stronger signal of the two, because it cannot be explained by the
   * world -- a lane cannot have looked at nothing everywhere and be fine.
   */
  workColumn?: string;
  /** Why a collapse here is a defect in the lane rather than a fact. */
  reason: string;
}

/**
 * The lanes that classify, and what their degenerate output is.
 *
 * `attribution_sweeps` is the subject #11226 was filed about. It is a
 * CURRENT-STATE table -- one row per subnet, overwritten each pass -- so the
 * check reads all of it rather than a window, and "the whole fleet" is
 * literally every row.
 */
export const CLASSIFYING_LANES: readonly ClassifyingLane[] = [
  {
    table: "attribution_sweeps",
    verdictColumn: "verdict",
    // The sweep's own word for "this subnet publishes nothing I can fetch".
    // Legitimate per subnet; impossible across all of them while the registry
    // publishes thousands of sweepable surfaces.
    barren: "no-sources",
    workColumn: "sources_checked",
    reason:
      "the registry publishes ~2,900 sweepable http(s) surfaces across these " +
      "same subnets, so a fleet-wide no-sources is a contradiction between two " +
      "things this repo publishes rather than a finding about the subnets",
  },
];

/** One `GROUP BY verdict` row, as the driver hands it back. */
export interface VerdictTally {
  verdict: string;
  rows: number;
  work: number;
}

export type DegenerateFault = "barren" | "idle";

export interface DegenerateVerdict {
  table: string;
  fault: DegenerateFault;
  detail: string;
}

/**
 * The rule alone -- no database, no clock.
 *
 * Returns null for a healthy lane, INCLUDING one with no rows at all: an empty
 * table is freshness's question, and answering it here would put two alarms on
 * one fact and neither of them able to clear the other.
 */
export function degenerateFault(
  lane: ClassifyingLane,
  tallies: readonly VerdictTally[],
): DegenerateVerdict | null {
  const total = tallies.reduce((n, t) => n + t.rows, 0);
  if (total === 0) return null;

  // IDLE FIRST, because it is the stronger claim and the more actionable one.
  // A lane whose work counter is zero everywhere never reached its inputs; a
  // barren verdict is what that then looks like from the outside, so reporting
  // both would name one fault twice.
  if (lane.workColumn) {
    const work = tallies.reduce((n, t) => Math.max(n, t.work), 0);
    if (work === 0) {
      return {
        table: lane.table,
        fault: "idle",
        detail:
          `${lane.table}: ${lane.workColumn} is 0 across all ${total} row(s) -- ` +
          `the lane completed every pass and looked at nothing. ${lane.reason}`,
      };
    }
  }

  const barren = tallies.find((t) => t.verdict === lane.barren);
  if (barren && barren.rows === total) {
    return {
      table: lane.table,
      fault: "barren",
      detail:
        `${lane.table}: all ${total} row(s) report ${lane.verdictColumn}=` +
        `${lane.barren} -- a classifier whose output is uniform is reporting a ` +
        `defect in itself. ${lane.reason}`,
    };
  }
  return null;
}

/** The one query this asks per lane -- the query #11226 was filed with. */
export function tallySql(lane: ClassifyingLane): string {
  const work = lane.workColumn
    ? `max(${lane.workColumn})`
    : // No counter declared, so nothing can read zero -- a constant keeps the
      // row shape identical rather than making the caller branch on it.
      "1";
  return (
    `SELECT ${lane.verdictColumn} AS verdict, count(*) AS rows, ` +
    `${work} AS work FROM ${lane.table} GROUP BY ${lane.verdictColumn}`
  );
}

export interface DegenerateOutputDeps {
  db?: UntypedRowQuerier | null;
  laneHealthDb?: LaneHealthDb | null;
  recordException?: typeof recordExceptionEvent;
  now?: () => number;
}

export interface DegenerateOutputResult {
  ok: boolean;
  reason?: string;
  faults: DegenerateVerdict[];
  checked: number;
}

/** One tick: every declared lane, one query each. */
export async function runDegenerateOutputWatchdog(
  // The same loose shape every sibling watchdog takes: callers hand in an
  // `Env`, a bag, or nothing, and a narrower type pushes a cast to the cron.
  env: Record<string, unknown> | null | undefined,
  deps: DegenerateOutputDeps = {},
): Promise<DegenerateOutputResult> {
  const db = deps.db ?? readStore(env, ["attribution_sweeps"]);
  if (!db?.query) {
    return { ok: false, reason: "no read store bound", faults: [], checked: 0 };
  }
  const now = deps.now ?? Date.now;
  const faults: DegenerateVerdict[] = [];
  let checked = 0;
  for (const lane of CLASSIFYING_LANES) {
    let rows: Record<string, unknown>[];
    try {
      rows = await db.query(tallySql(lane));
    } catch (err) {
      // ONE LANE'S FAILURE IS NOT THE TICK'S. A table that does not exist yet
      // -- a migration applied by hand, which is how they land here -- must not
      // stop the lanes after it being checked.
      await (deps.recordException ?? recordExceptionEvent)(env, {
        error: err instanceof Error ? err : new Error(String(err)),
        route: `watchdog:${DEGENERATE_OUTPUT_LANE}`,
        errorCode: "degenerate_output_query_failed",
      });
      continue;
    }
    checked += 1;
    const fault = degenerateFault(
      lane,
      rows.map((row) => ({
        verdict: String(row.verdict ?? ""),
        rows: countOrZero(row.rows),
        work: countOrZero(row.work),
      })),
    );
    if (fault) faults.push(fault);
  }

  await recordLaneVerdict(deps.laneHealthDb ?? laneHealthStore(env), {
    lane: DEGENERATE_OUTPUT_LANE,
    verdict: faults.length ? "stale" : "ok",
    age_ms: null,
    detail: faults.length
      ? faults.map((f) => f.detail).join("; ")
      : `${checked} classifying lane(s), none degenerate`,
    checked_at: now(),
  });
  return { ok: faults.length === 0, faults, checked };
}
