// The alarm for the nominator-positions lane (#9273).
//
// This watchdog exists because of what happened WITHOUT one. The lane's writer
// lived on a box that was decommissioned, and nothing anywhere noticed: the
// route over the ledger kept returning 200s off a frozen export for 34 hours
// and counting, with a `captured_at` that could never advance and a confident
// `positions: 0` for every coldkey that started delegating after the export.
// No probe, no red check, no exception -- the failure was invisible precisely
// because the read path degraded so gracefully.
//
// Same shape as src/neurons-staleness-watchdog.ts deliberately: one MAX() read,
// a pure rule, a summary rather than a throw, and one exception event per stale
// tick on the project's alert channel. Zero alerts is the correct steady state.

import { recordExceptionEvent } from "./usage-telemetry.ts";
import { recordLaneVerdict, type LaneHealthDb } from "./lane-health.ts";

/**
 * How old the ledger may get before this is a stall.
 *
 * THIRTY HOURS, not the neurons lane's 45 minutes, and the difference is the
 * work: this lane is a full SubtensorModule::Alpha scan (~153k rows across
 * every coldkey on the network), which is why it never shared the 15-minute
 * metagraph cadence even when it ran.
 *
 * CORRECTED from six hours (#9301). Six was chosen while the lane had no
 * producer at all, on the reasoning that it was "several missed passes at any
 * plausible cadence" -- but the producer that now feeds it runs on a 24h tick
 * (VALIDATOR_NOMINATORS_POLL_SECS defaults to 24*3600 in metagraphed-infra's
 * poller, and one job's scan writes BOTH this table and
 * validator_nominator_counts). A healthy lane therefore presents an age
 * anywhere in [0h, 24h+scan] at any moment, so a six-hour threshold would have
 * alerted for roughly three quarters of every day on a lane working perfectly
 * -- the failure mode where an alarm that always fires stops being read.
 *
 * 30h is one missed pass plus slack for the scan itself (~4 minutes at the
 * measured ~3,100 rows/sec) and cron jitter. It fires only once a pass has
 * genuinely been skipped, and still catches a writer that stopped entirely
 * inside a day and a quarter rather than never.
 *
 * Overridable per-deployment via NOMINATOR_POSITIONS_STALENESS_THRESHOLD_MS so
 * the number can follow the Container's cadence without a code deploy.
 */
export const NOMINATOR_POSITIONS_STALENESS_THRESHOLD_MS = 30 * 60 * 60 * 1000;

export interface NominatorPositionsStalenessVerdict {
  stale: boolean;
  reason: "no_rows" | "stale" | null;
  age_ms: number | null;
  latest_captured_at: number | null;
  threshold_ms: number;
}

/** The rule alone, testable without a database or a clock. */
export function evaluateNominatorPositionsStaleness(input: {
  latestCapturedAtMs: number | null;
  nowMs: number;
  thresholdMs: number;
}): NominatorPositionsStalenessVerdict {
  const { latestCapturedAtMs, nowMs, thresholdMs } = input;
  if (latestCapturedAtMs === null) {
    // An empty table is a stall of infinite age, not a healthy quiet one --
    // and here it is also the CUTOVER state, before the revived lane has
    // posted anything. That is exactly the condition worth alerting on: an
    // empty hot tier means every positions read is still answering from the
    // frozen lakehouse export.
    return {
      stale: true,
      reason: "no_rows",
      age_ms: null,
      latest_captured_at: null,
      threshold_ms: thresholdMs,
    };
  }
  const age = nowMs - latestCapturedAtMs;
  return {
    stale: age > thresholdMs,
    reason: age > thresholdMs ? "stale" : null,
    age_ms: age,
    latest_captured_at: latestCapturedAtMs,
    threshold_ms: thresholdMs,
  };
}

interface D1Like {
  prepare(sql: string): {
    first(): Promise<unknown>;
  };
}

export interface NominatorPositionsStalenessDeps {
  /** Injectable durable sink, so a test can assert the verdict was RECORDED and
   * not merely notified — the distinction #9330/#9340 exist about. */
  laneHealthDb?: LaneHealthDb | null;
  now?: () => number;
  /** Telemetry seam for tests; defaults to the real recordExceptionEvent. */
  recordException?: typeof recordExceptionEvent;
}

/**
 * One watchdog tick. Returns a summary rather than throwing, matching the
 * watchdog family: a tick that cannot run is one missed report, not an outage,
 * and a cron that throws is a cron nobody can read the result of.
 */
export async function runNominatorPositionsStalenessWatchdog(
  env: Record<string, unknown> | null | undefined,
  deps: NominatorPositionsStalenessDeps = {},
): Promise<Record<string, unknown>> {
  const now = deps.now ?? Date.now;
  const record = deps.recordException ?? recordExceptionEvent;
  const db = env?.METAGRAPH_HEALTH_DB as D1Like | undefined;
  if (!db?.prepare) return { ok: false, reason: "d1 binding unavailable" };

  const thresholdMs =
    Number(env?.NOMINATOR_POSITIONS_STALENESS_THRESHOLD_MS) ||
    NOMINATOR_POSITIONS_STALENESS_THRESHOLD_MS;

  try {
    const row = (await db
      .prepare("SELECT MAX(captured_at) AS latest FROM nominator_positions")
      .first()) as { latest: number | null } | null;
    const verdict = evaluateNominatorPositionsStaleness({
      latestCapturedAtMs: row?.latest ?? null,
      nowMs: now(),
      thresholdMs,
    });
    if (verdict.stale) {
      const age =
        verdict.age_ms === null
          ? "no rows at all"
          : `${(verdict.age_ms / 3_600_000).toFixed(1)} h old`;
      await record(env as never, {
        error: new Error(
          `nominator-positions lane stalled: latest snapshot is ${age} (threshold ${thresholdMs / 3_600_000} h) -- /accounts/{ss58}/positions is answering from a ledger nothing is refreshing`,
        ),
        route: "watchdog:nominator-positions-staleness",
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
        lane: "nominator-positions-staleness",
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
