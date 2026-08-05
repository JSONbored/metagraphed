// The alarm for the account-balances lane (#9478).
//
// This watchdog exists because of what happened WITHOUT one, twice over. The
// lane's writer targeted a Postgres that was decommissioned, and nothing
// anywhere noticed: /api/v1/accounts/top-holders kept answering 200 off a
// one-shot materialization taken 2026-08-02, with a `captured_at` that could
// never advance and a free_tao column that silently misreported every account
// that had moved TAO since. It was found by a caller reading the timestamp --
// the same way #9273 and #9423 were found, and the same way #9464 was.
//
// DISTINCT FROM src/top-holders-staleness-watchdog.ts, which is not superseded
// by this file. That one watches the SERVED ARTIFACT -- whether the object the
// route reads is present, readable, non-empty and off its frozen constant. This
// one watches the SOURCE TABLE that feeds it. The two fail independently and
// the difference is the repair: a fresh table behind a stale artifact is a
// composition/publish problem, while a stale table behind either is the
// producer. Watching only the artifact is what left the underlying lane's
// absence invisible for as long as it was.
//
// Same shape as src/nominator-positions-staleness-watchdog.ts deliberately: one
// MAX() read, a pure rule, a summary rather than a throw, and one exception
// event per stale tick on the project's alert channel. Zero alerts is the
// correct steady state.

import { recordExceptionEvent } from "./usage-telemetry.ts";
import { recordLaneVerdict, type LaneHealthDb } from "./lane-health.ts";

/**
 * How old the ledger may get before this is a stall.
 *
 * TWELVE HOURS, the same number src/top-holders-staleness-watchdog.ts sized
 * against this exact producer and for the same reason: the poller's
 * `ACCOUNT_BALANCES_POLL_SECS` defaults to 21600 (six hours), and the pass
 * behind it is a full System::Account walk -- 542,618 entries measured
 * 2026-07-19 -- so a healthy lane's age swings across the whole six-hour
 * interval plus however long the walk and its ~22 POSTs take.
 *
 * Twelve is one full cadence of slack on top of that: it cannot fire until a
 * pass has genuinely been skipped. That is the sizing rule #9301 corrected the
 * nominator-positions threshold for, after a six-hour bound was set against a
 * 24-hour producer and alerted for three quarters of every day on a lane that
 * was working perfectly -- the failure mode where an alarm that always fires
 * stops being read.
 *
 * Overridable per-deployment via ACCOUNT_BALANCES_STALENESS_THRESHOLD_MS so the
 * number can follow the Container's cadence without a code deploy.
 */
export const ACCOUNT_BALANCES_STALENESS_THRESHOLD_MS = 12 * 60 * 60 * 1000;

export interface AccountBalancesStalenessVerdict {
  stale: boolean;
  reason: "no_rows" | "stale" | null;
  age_ms: number | null;
  latest_captured_at: number | null;
  threshold_ms: number;
}

/** The rule alone, testable without a database or a clock. */
export function evaluateAccountBalancesStaleness(input: {
  latestCapturedAtMs: number | null;
  nowMs: number;
  thresholdMs: number;
}): AccountBalancesStalenessVerdict {
  const { latestCapturedAtMs, nowMs, thresholdMs } = input;
  if (latestCapturedAtMs === null) {
    // An empty table is a stall of infinite age, not a healthy quiet one --
    // and here it is also the CUTOVER state, before the revived lane has
    // posted anything. That is exactly the condition worth alerting on: an
    // empty table means every top-holders read is still answering from the
    // frozen 2026-08-02 artifact.
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

export interface AccountBalancesStalenessDeps {
  /** Injectable durable sink, so a test can assert the verdict was RECORDED and
   * not merely notified -- the distinction #9330/#9340 exist about. */
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
export async function runAccountBalancesStalenessWatchdog(
  env: Record<string, unknown> | null | undefined,
  deps: AccountBalancesStalenessDeps = {},
): Promise<Record<string, unknown>> {
  const now = deps.now ?? Date.now;
  const record = deps.recordException ?? recordExceptionEvent;
  const db = env?.METAGRAPH_HEALTH_DB as D1Like | undefined;
  if (!db?.prepare) return { ok: false, reason: "d1 binding unavailable" };

  const thresholdMs =
    Number(env?.ACCOUNT_BALANCES_STALENESS_THRESHOLD_MS) ||
    ACCOUNT_BALANCES_STALENESS_THRESHOLD_MS;

  try {
    const row = (await db
      .prepare("SELECT MAX(captured_at) AS latest FROM account_balances")
      .first()) as { latest: number | null } | null;
    const verdict = evaluateAccountBalancesStaleness({
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
          `account-balances lane stalled: latest snapshot is ${age} (threshold ${thresholdMs / 3_600_000} h) -- /accounts/top-holders is answering from a free_tao column nothing is refreshing`,
        ),
        route: "watchdog:account-balances-staleness",
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
        lane: "account-balances-staleness",
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
