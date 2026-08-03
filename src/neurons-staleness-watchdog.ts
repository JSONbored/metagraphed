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

import { recordExceptionEvent } from "./usage-telemetry.ts";

/** Three missed 15-minute ticks: one restart is routine (a deploy or an
 * eviction costs one tick by design), two could be an unlucky pair, three is
 * a stall. */
export const NEURONS_STALENESS_THRESHOLD_MS = 45 * 60 * 1000;

export interface NeuronsStalenessVerdict {
  stale: boolean;
  reason: "no_rows" | "stale" | null;
  age_ms: number | null;
  latest_captured_at: number | null;
  threshold_ms: number;
}

/** The rule alone, testable without a database or a clock. */
export function evaluateNeuronsStaleness(input: {
  latestCapturedAtMs: number | null;
  nowMs: number;
  thresholdMs: number;
}): NeuronsStalenessVerdict {
  const { latestCapturedAtMs, nowMs, thresholdMs } = input;
  if (latestCapturedAtMs === null) {
    // An empty table is a stall of infinite age, not a healthy quiet one.
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

export interface NeuronsStalenessDeps {
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

  try {
    const row = (await db
      .prepare("SELECT MAX(captured_at) AS latest FROM neurons")
      .first()) as { latest: number | null } | null;
    const verdict = evaluateNeuronsStaleness({
      latestCapturedAtMs: row?.latest ?? null,
      nowMs: now(),
      thresholdMs,
    });
    if (verdict.stale) {
      const age =
        verdict.age_ms === null
          ? "no rows at all"
          : `${(verdict.age_ms / 60_000).toFixed(1)} min old`;
      await record(env as never, {
        error: new Error(
          `neurons lane stalled: latest snapshot is ${age} (threshold ${thresholdMs / 60_000} min) -- the poller Container has missed at least three ticks`,
        ),
        route: "watchdog:neurons-staleness",
        errorCode: "stale_lane",
      }).catch(() => false);
    }
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
