// The alarm for the validator-nominator-counts lane (#9301).
//
// This watchdog exists because of what happened WITHOUT one. The lane's writer
// wrote to a Postgres that was decommissioned, and nothing anywhere noticed:
// `nominator_count` on /api/v1/validators and /api/v1/validators/{hotkey} kept
// serving 200s off a frozen lakehouse mirror whose newest capture was
// 2026-08-02, covering 564 of 1,031 validators and silently losing ground as
// new ones registered. No probe, no red check, no exception -- the failure was
// invisible precisely because the read path degrades to `null` so gracefully.
//
// Same shape as src/nominator-positions-staleness-watchdog.ts deliberately --
// its sibling from the SAME producer scan -- and as
// src/neurons-staleness-watchdog.ts before it: one MAX() read, a pure rule, a
// summary rather than a throw, and one exception event per stale tick on the
// project's alert channel. Zero alerts is the correct steady state.

import { recordExceptionEvent } from "./usage-telemetry.ts";
import { recordLaneVerdict, type LaneHealthDb } from "./lane-health.ts";

/**
 * How old the counts table may get before this is a stall.
 *
 * THIRTY HOURS, and the number is derived from the producer's cadence rather
 * than picked: the lane is a full SubtensorModule::Alpha scan on a 24h tick
 * (VALIDATOR_NOMINATORS_POLL_SECS defaults to 24*3600 in metagraphed-infra's
 * poller). A healthy lane therefore presents an age anywhere in [0h, 24h+scan]
 * at any moment, so any threshold at or under 24 hours alerts on a lane that
 * is working perfectly. 30h is one missed pass plus slack for the scan itself
 * (~4 minutes at the measured ~3,100 rows/sec) and cron jitter -- it fires
 * only once a pass has genuinely been skipped, and still catches the failure
 * class this exists for (a writer that stopped entirely) inside a day and a
 * quarter rather than never.
 *
 * Overridable per-deployment via
 * VALIDATOR_NOMINATOR_COUNTS_STALENESS_THRESHOLD_MS so the number can follow
 * the Container's cadence without a code deploy.
 */
export const VALIDATOR_NOMINATOR_COUNTS_STALENESS_THRESHOLD_MS =
  30 * 60 * 60 * 1000;

export interface ValidatorNominatorCountsStalenessVerdict {
  stale: boolean;
  reason: "no_rows" | "stale" | null;
  age_ms: number | null;
  latest_captured_at: number | null;
  threshold_ms: number;
}

/** The rule alone, testable without a database or a clock. */
export function evaluateValidatorNominatorCountsStaleness(input: {
  latestCapturedAtMs: number | null;
  nowMs: number;
  thresholdMs: number;
}): ValidatorNominatorCountsStalenessVerdict {
  const { latestCapturedAtMs, nowMs, thresholdMs } = input;
  if (latestCapturedAtMs === null) {
    // An empty table is a stall of infinite age, not a healthy quiet one --
    // and here it is also the CUTOVER state, before the re-enabled lane has
    // posted anything. That is exactly the condition worth alerting on: an
    // empty hot tier means every nominator_count is still being filled from
    // the frozen lakehouse mirror, or left null outright.
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

export interface ValidatorNominatorCountsStalenessDeps {
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
export async function runValidatorNominatorCountsStalenessWatchdog(
  env: Record<string, unknown> | null | undefined,
  deps: ValidatorNominatorCountsStalenessDeps = {},
): Promise<Record<string, unknown>> {
  const now = deps.now ?? Date.now;
  const record = deps.recordException ?? recordExceptionEvent;
  const db = env?.METAGRAPH_HEALTH_DB as D1Like | undefined;
  if (!db?.prepare) return { ok: false, reason: "d1 binding unavailable" };

  const thresholdMs =
    Number(env?.VALIDATOR_NOMINATOR_COUNTS_STALENESS_THRESHOLD_MS) ||
    VALIDATOR_NOMINATOR_COUNTS_STALENESS_THRESHOLD_MS;

  try {
    const row = (await db
      .prepare(
        "SELECT MAX(captured_at) AS latest FROM validator_nominator_counts",
      )
      .first()) as { latest: number | null } | null;
    const verdict = evaluateValidatorNominatorCountsStaleness({
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
          `validator-nominator-counts lane stalled: latest snapshot is ${age} (threshold ${thresholdMs / 3_600_000} h) -- /validators is serving nominator_count from a table nothing is refreshing`,
        ),
        route: "watchdog:validator-nominator-counts-staleness",
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
        lane: "validator-nominator-counts-staleness",
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
