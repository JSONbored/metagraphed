// The alarm for the neurons LIVE lane -- the one freshness surface no other
// watchdog covers. runFreshnessWatchdog reads the publish-freshness artifact,
// which tracks build/publish lanes; the neurons table in D1 is fed by the
// poller Container's 15-minute tick, and when that tick stalls the routes over
// it keep serving healthy-looking 200s from an aging snapshot. The first such
// stall (2026-08-03: a zombie container instance, "running" with healthy:0)
// went three hours without a single alert. This is the alarm that makes the
// next one cost fifteen minutes, not three hours.
//
// Zero alerts is the correct steady state. A stale verdict records ONE
// exception event per tick (route watchdog:neurons-staleness), which is the
// project's alert channel; the cron summary carries the age either way so a
// healthy check is still legible.
//
// ## COVERAGE IS COUNTED IN NETUIDS HERE, NOT ROWS
//
// #9530 established that `MAX(captured_at)` cannot distinguish a complete pass
// from a truncated one, after 147,000 account_balances rows -- 48% of the
// network -- reported `ok | age=0.6h` in production. This lane has the same
// blind spot by a DIFFERENT mechanism, and the mechanism is what picks the
// unit.
//
// There is no chunked upload to truncate: NEURONS_SYNC_MAX_ROWS is 50,000 and
// the whole metagraph is at most 129 subnets x 256 UIDs = 33,024 rows (30,103
// measured 2026-08-05), so a pass is always ONE request. The hazard is upstream
// of that -- the producer scans netuid by netuid over RPC, and this lane's
// writer (src/neurons-d1-write.ts) prunes PER NETUID: it deletes the UIDs its
// batch did not refresh, but only within the netuids the batch contains. A
// netuid absent from the payload is left completely untouched, still carrying
// its previous stamp. So a scan that dies at netuid 40 posts a well-formed
// request, restamps 40 subnets, and leaves 89 serving data a pass old behind a
// `MAX(captured_at)` that just advanced.
//
// ROWS WOULD BE THE WRONG UNIT for that. Subnets vary from 64 to 256 UIDs, so a
// scan that died after the largest 60 could show high row coverage while having
// missed more than half the network. Netuids covered is what the producer
// actually iterates, so it is what a partial pass is partial IN. Measured
// 2026-08-05: 129 of 129 netuids at the newest stamp, a single vintage across
// the whole table -- the prune keeps it that way when a pass completes, which
// is also why any vintage spread at all is a signal here.
//
// COST: one walk of ~30k rows on a `6,21,36,51 * * * *` cron, 96 ticks a day,
// so ~2.9M D1 rows read a day.

import { recordExceptionEvent } from "./usage-telemetry.ts";
import { recordLaneVerdict, type LaneHealthDb } from "./lane-health.ts";

/** Three missed 15-minute ticks: one restart is routine (a deploy or an
 * eviction costs one tick by design), two could be an unlucky pair, three is
 * a stall. */
export const NEURONS_STALENESS_THRESHOLD_MS = 45 * 60 * 1000;

/**
 * How many subnets a COMPLETE pass is expected to cover.
 *
 * 129, read off production D1 on 2026-08-05 as `COUNT(DISTINCT netuid)` at the
 * newest stamp, and matching the 129 native subnets `npm run validate` reports
 * from the registry -- two independent counts of the same thing.
 */
export const NEURONS_EXPECTED_NETUIDS = 129;

/**
 * How much of that a single pass must cover before it counts as complete.
 *
 * EIGHTY PERCENT (~103 subnets), the same ratio the sibling lanes use, and the
 * slack here is doing real work rather than being copied: the subnet count is
 * not fixed. New subnets register, and a floor sized exactly to today's 129
 * would be a floor that has to be edited every time the network grows. Sized
 * this way it only ever gets SLACKER as subnets are added, never tighter, which
 * is the safe direction -- the #9301 rule that an alarm firing on a working
 * lane stops being read.
 *
 * The cost of that slack is the honest one: a scan that dies in its last 20% of
 * subnets is not caught. It is bounded, visible, and far better than the
 * present state of not catching a scan that dies at 30%.
 *
 * Overridable via NEURONS_COVERAGE_FLOOR_NETUIDS -- and note this is the number
 * to LOWER if the network ever contracts below it, not a number to chase upward
 * as subnets are added.
 */
export const NEURONS_COVERAGE_FLOOR_RATIO = 0.8;

/** The floor the rule compares against, ~103 subnets. */
export const NEURONS_COVERAGE_FLOOR_NETUIDS = Math.round(
  NEURONS_EXPECTED_NETUIDS * NEURONS_COVERAGE_FLOOR_RATIO,
);

/**
 * How far back from the newest stamp still counts as "the newest pass".
 *
 * FIVE MINUTES, a third of the producer's 15-minute tick. Bounded from both
 * ends like its siblings, but the ceiling binds much harder here because the
 * cadence is so short: anything at or over 15 minutes would merge two ticks
 * into one coverage count, letting a half-scanned pass sitting on a complete
 * one report full coverage -- exactly the bug this is closing. The floor is
 * comfortable in the other direction, since a pass arrives as a single request
 * and therefore carries a single stamp (measured: one vintage across all 30,103
 * rows).
 *
 * Overridable via NEURONS_PASS_WINDOW_MS, which must be re-sized against the
 * poller's tick if that tick ever changes.
 */
export const NEURONS_PASS_WINDOW_MS = 5 * 60 * 1000;

/**
 * One read, answering both questions: how fresh the newest pass is, and how
 * many subnets it actually reached.
 *
 * `total` is the netuid count across ALL vintages -- context rather than the
 * rule. Read together the pair is the diagnosis: `covered` well under `total`
 * is a scan that died partway through the network.
 */
const NEURONS_COVERAGE_SQL =
  "SELECT COUNT(DISTINCT netuid) AS total, MAX(captured_at) AS latest, " +
  "COUNT(DISTINCT CASE WHEN captured_at >= " +
  "(SELECT MAX(captured_at) FROM neurons) - ? THEN netuid END) AS covered " +
  "FROM neurons";

export type NeuronsStalenessReason = "no_rows" | "stale" | "partial" | null;

export interface NeuronsStalenessVerdict {
  stale: boolean;
  reason: NeuronsStalenessReason;
  age_ms: number | null;
  latest_captured_at: number | null;
  threshold_ms: number;
  /** Subnets the newest pass covered. The coverage signal itself. */
  covered_netuids: number;
  /** Subnets present in the table across all vintages. Context, never the rule. */
  total_netuids: number;
  coverage_floor_netuids: number;
}

/** The rule alone, testable without a database or a clock. */
export function evaluateNeuronsStaleness(input: {
  latestCapturedAtMs: number | null;
  coveredNetuids: number;
  totalNetuids: number;
  nowMs: number;
  thresholdMs: number;
  coverageFloorNetuids: number;
}): NeuronsStalenessVerdict {
  const {
    latestCapturedAtMs,
    coveredNetuids,
    totalNetuids,
    nowMs,
    thresholdMs,
    coverageFloorNetuids,
  } = input;
  const base = {
    latest_captured_at: latestCapturedAtMs,
    threshold_ms: thresholdMs,
    covered_netuids: coveredNetuids,
    total_netuids: totalNetuids,
    coverage_floor_netuids: coverageFloorNetuids,
  };
  if (latestCapturedAtMs === null) {
    // An empty table is a stall of infinite age, not a healthy quiet one.
    return { ...base, stale: true, reason: "no_rows", age_ms: null };
  }
  const age = nowMs - latestCapturedAtMs;
  if (age > thresholdMs) {
    // Checked BEFORE coverage: if the Container has missed three ticks, the
    // coverage number describes an old pass and the headline is that it stopped.
    return { ...base, stale: true, reason: "stale", age_ms: age };
  }
  if (coveredNetuids < coverageFloorNetuids) {
    // Recent AND short -- a scan that died partway through the netuid walk,
    // leaving the subnets it never reached behind a freshly advanced MAX().
    return { ...base, stale: true, reason: "partial", age_ms: age };
  }
  return { ...base, stale: false, reason: null, age_ms: age };
}

/** A null count over no rows, or a shim that stringifies, must land on 0 rather
 * than NaN -- a NaN compares false against the floor and would report a
 * half-scanned network healthy. */
function countOrZero(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): { first(): Promise<unknown> };
  };
}

export interface NeuronsStalenessDeps {
  /** Injectable durable sink, so a test can assert the verdict was RECORDED and
   * not merely notified — the distinction #9330/#9340 exist about. */
  laneHealthDb?: LaneHealthDb | null;
  now?: () => number;
  /** Telemetry seam for tests; defaults to the real recordExceptionEvent. */
  recordException?: typeof recordExceptionEvent;
}

/**
 * One watchdog tick. Returns a summary rather than throwing, matching the
 * watchdog family: a tick that cannot run is one missed report, not an
 * outage, and a cron that throws is a cron nobody can read the result of.
 */
export async function runNeuronsStalenessWatchdog(
  env: Record<string, unknown> | null | undefined,
  deps: NeuronsStalenessDeps = {},
): Promise<Record<string, unknown>> {
  const now = deps.now ?? Date.now;
  const record = deps.recordException ?? recordExceptionEvent;
  const db = env?.METAGRAPH_HEALTH_DB as D1Like | undefined;
  if (!db?.prepare) return { ok: false, reason: "d1 binding unavailable" };

  const thresholdMs =
    Number(env?.NEURONS_STALENESS_THRESHOLD_MS) ||
    NEURONS_STALENESS_THRESHOLD_MS;
  const passWindowMs =
    Number(env?.NEURONS_PASS_WINDOW_MS) || NEURONS_PASS_WINDOW_MS;
  const coverageFloorNetuids =
    Number(env?.NEURONS_COVERAGE_FLOOR_NETUIDS) ||
    NEURONS_COVERAGE_FLOOR_NETUIDS;

  try {
    const row = (await db
      .prepare(NEURONS_COVERAGE_SQL)
      .bind(passWindowMs)
      .first()) as {
      latest: number | null;
      covered: number | null;
      total: number | null;
    } | null;
    const verdict = evaluateNeuronsStaleness({
      latestCapturedAtMs: row?.latest ?? null,
      coveredNetuids: countOrZero(row?.covered),
      totalNetuids: countOrZero(row?.total),
      nowMs: now(),
      thresholdMs,
      coverageFloorNetuids,
    });
    if (verdict.stale) {
      // The two faults get different wording on purpose -- "the Container
      // stopped" and "the Container is running and the scan is not finishing"
      // send whoever reads the alert to different places.
      const age =
        verdict.age_ms === null
          ? "no rows at all"
          : `${(verdict.age_ms / 60_000).toFixed(1)} min old`;
      const message =
        verdict.reason === "partial"
          ? `neurons lane truncated: the newest pass covered only ${verdict.covered_netuids} of ${verdict.total_netuids} subnets against a floor of ${verdict.coverage_floor_netuids} (newest stamp ${age}) -- the capture is RECENT and PARTIAL, so every route over a subnet the scan never reached is serving a pass-old metagraph behind a MAX(captured_at) that just advanced`
          : `neurons lane stalled: latest snapshot is ${age} (threshold ${thresholdMs / 60_000} min) -- the poller Container has missed at least three ticks`;
      await record(env as never, {
        error: new Error(message),
        route: "watchdog:neurons-staleness",
        errorCode: "stale_lane",
      }).catch(() => false);
    }
    // #9330/#9340: the DURABLE record, written every tick rather than only when
    // stale. PostHog stays the notification path; it is no longer the record, because
    // a dropped $exception is indistinguishable from a lane that was fine. Writing on
    // every tick is also what makes "the watchdog stopped running" visible at all.
    // Never throws -- see recordLaneVerdict.
    await recordLaneVerdict(
      deps.laneHealthDb ?? (env?.METAGRAPH_HEALTH_DB as never),
      {
        lane: "neurons-staleness",
        verdict: verdict.stale ? "stale" : "ok",
        age_ms: verdict.age_ms,
        detail: verdict.reason ?? null,
        checked_at: now(),
      },
    );
    // `ok` describes whether the TICK ran, not whether the lane is fresh.
    return { ok: true, alerted: verdict.stale, ...verdict };
  } catch (err) {
    return {
      ok: false,
      reason: "query_failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
