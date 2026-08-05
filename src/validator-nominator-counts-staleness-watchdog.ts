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
// src/neurons-staleness-watchdog.ts before it: a single read, a pure rule, a
// summary rather than a throw, and one exception event per stale tick on the
// project's alert channel. Zero alerts is the correct steady state.
//
// ## COVERAGE, because freshness alone cannot see a truncated pass
//
// This lane has the SAME structural blind spot #9530 fixed on
// src/account-balances-staleness-watchdog.ts, and for the same reason rather
// than by analogy: src/validator-nominator-counts-d1-write.ts is explicitly NO
// PRUNE, so a chunked pass that dies partway upserts the rows it reached to a
// new stamp and leaves the rest at the old one. `MAX(captured_at)` reads the
// rows that DID land, reports them genuinely fresh, and says nothing about the
// ones that did not. On account_balances that failure reached production:
// 147,000 rows -- 48% of the network -- reported `ok | age=0.6h`.
//
// So this watchdog also counts the hotkeys the NEWEST pass wrote, against a
// floor sized to the scan. Counting the pass rather than the table is the whole
// point: with no prune, a truncated pass cannot shrink the table, so a
// whole-table `COUNT(*)` floor reads the full population and reports fine. See
// the account-balances module header for why a producer-published completeness
// marker loses here too (a pass that dies never sends its marker, which puts
// the watchdog back to inferring from an absence of report -- the check that
// already said `ok`).
//
// MEASURED 2026-08-05, production D1: 112,250 rows total across three vintages
// -- 112,245 at the newest stamp, then 1 and 4 rows at two older ones. Those
// five stragglers are the no-prune behaviour working as designed (a hotkey the
// latest scan did not re-send keeps its last known count), and they are why
// coverage is counted over a WINDOW rather than an exact stamp match.
//
// COST: one walk of ~112k rows on a `19,49 * * * *` cron, 48 ticks a day, so
// ~5.4M D1 rows read a day.

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

/**
 * How many hotkeys a COMPLETE pass is expected to write.
 *
 * 112,245, read off production D1 on 2026-08-05 as the row count at the newest
 * `captured_at`. The table is keyed on (hotkey) alone, so a row IS a hotkey --
 * every hotkey the SubtensorModule::Alpha scan found with at least one
 * nominator.
 */
export const VALIDATOR_NOMINATOR_COUNTS_EXPECTED_HOTKEYS = 112_245;

/**
 * How much of that a single pass must cover before it counts as complete.
 *
 * EIGHTY PERCENT, placed against the chunking rather than picked round: the
 * sync route caps a request at 25,000 rows, so a full pass is ~5 requests and a
 * death partway lands near 25k / 50k / 75k / 100k. This floor (~89,800) catches
 * every one of those but the last, which is the right trade -- tightening it
 * far enough to catch a 4-of-5 death would put the alarm inside the noise band
 * of ordinary population change.
 *
 * THE DRIFT DIRECTION IS DIFFERENT HERE than on account_balances, and worth
 * knowing before retuning. That lane's expectation only grows (it counts
 * accounts that have EVER held a balance). This one counts hotkeys with a
 * nominator RIGHT NOW, which can genuinely shrink as delegation concentrates or
 * miners deregister. So if this ever fires MARGINALLY -- a covered count a few
 * percent under the floor, on a lane that is otherwise healthy -- the answer is
 * to re-measure the population and lower this, not to go hunting for a
 * truncated pass. A death mid-scan looks nothing like that; it lands near a
 * chunk boundary, far below.
 *
 * Overridable via VALIDATOR_NOMINATOR_COUNTS_COVERAGE_FLOOR_ROWS.
 */
export const VALIDATOR_NOMINATOR_COUNTS_COVERAGE_FLOOR_RATIO = 0.8;

/** The floor the rule compares against, ~89,796 hotkeys. */
export const VALIDATOR_NOMINATOR_COUNTS_COVERAGE_FLOOR_ROWS = Math.round(
  VALIDATOR_NOMINATOR_COUNTS_EXPECTED_HOTKEYS *
    VALIDATOR_NOMINATOR_COUNTS_COVERAGE_FLOOR_RATIO,
);

/**
 * How far back from the newest stamp still counts as "the newest pass".
 *
 * FOUR HOURS, bounded from both ends like its account-balances counterpart but
 * against a much slower producer. Too small and the intra-pass spread reads as
 * several partial passes (the scan itself is ~4 minutes at the measured ~3,100
 * rows/sec, so four hours is three orders of magnitude of headroom); too large
 * and two consecutive passes merge into one coverage count, which would let a
 * truncated pass sitting on a complete one report full coverage and restore the
 * bug. VALIDATOR_NOMINATORS_POLL_SECS is 24 h, so this is a sixth of the
 * cadence -- nowhere near able to merge two passes.
 *
 * Overridable via VALIDATOR_NOMINATOR_COUNTS_PASS_WINDOW_MS, which must be
 * re-sized against the poll interval if that interval ever shortens.
 */
export const VALIDATOR_NOMINATOR_COUNTS_PASS_WINDOW_MS = 4 * 60 * 60 * 1000;

/**
 * One read, answering both questions: how fresh the newest pass is, and how
 * many hotkeys it actually reached.
 *
 * `total` is not used by the rule -- it rides along free on the same walk and
 * is what tells an operator how many older-vintage rows are sitting underneath
 * a partial pass.
 */
const VALIDATOR_NOMINATOR_COUNTS_COVERAGE_SQL =
  "SELECT COUNT(*) AS total, MAX(captured_at) AS latest, " +
  "SUM(CASE WHEN captured_at >= " +
  "(SELECT MAX(captured_at) FROM validator_nominator_counts) - ? " +
  "THEN 1 ELSE 0 END) AS covered FROM validator_nominator_counts";

export type ValidatorNominatorCountsStalenessReason =
  "no_rows" | "stale" | "partial" | null;

export interface ValidatorNominatorCountsStalenessVerdict {
  stale: boolean;
  reason: ValidatorNominatorCountsStalenessReason;
  age_ms: number | null;
  latest_captured_at: number | null;
  threshold_ms: number;
  /** Hotkeys the newest pass wrote. The coverage signal itself. */
  covered_rows: number;
  /** Hotkeys in the table across all vintages. Context, never the rule. */
  total_rows: number;
  coverage_floor_rows: number;
}

/** The rule alone, testable without a database or a clock. */
export function evaluateValidatorNominatorCountsStaleness(input: {
  latestCapturedAtMs: number | null;
  coveredRows: number;
  totalRows: number;
  nowMs: number;
  thresholdMs: number;
  coverageFloorRows: number;
}): ValidatorNominatorCountsStalenessVerdict {
  const {
    latestCapturedAtMs,
    coveredRows,
    totalRows,
    nowMs,
    thresholdMs,
    coverageFloorRows,
  } = input;
  const base = {
    latest_captured_at: latestCapturedAtMs,
    threshold_ms: thresholdMs,
    covered_rows: coveredRows,
    total_rows: totalRows,
    coverage_floor_rows: coverageFloorRows,
  };
  if (latestCapturedAtMs === null) {
    // An empty table is a stall of infinite age, not a healthy quiet one --
    // and here it is also the CUTOVER state, before the re-enabled lane has
    // posted anything. That is exactly the condition worth alerting on: an
    // empty hot tier means every nominator_count is still being filled from
    // the frozen lakehouse mirror, or left null outright.
    return { ...base, stale: true, reason: "no_rows", age_ms: null };
  }
  const age = nowMs - latestCapturedAtMs;
  if (age > thresholdMs) {
    // Checked BEFORE coverage: if the producer has missed a whole pass, the
    // coverage number describes an old one and the headline is that it stopped.
    return { ...base, stale: true, reason: "stale", age_ms: age };
  }
  if (coveredRows < coverageFloorRows) {
    // Recent AND short -- a pass that ran and did not finish, leaving a table
    // that reads fresh from its MAX() alone.
    return { ...base, stale: true, reason: "partial", age_ms: age };
  }
  return { ...base, stale: false, reason: null, age_ms: age };
}

/** A null SUM over no rows, or a shim that stringifies, must land on 0 rather
 * than NaN -- a NaN compares false against the floor and would report a
 * truncated table healthy. */
function countOrZero(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): { first(): Promise<unknown> };
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
  const passWindowMs =
    Number(env?.VALIDATOR_NOMINATOR_COUNTS_PASS_WINDOW_MS) ||
    VALIDATOR_NOMINATOR_COUNTS_PASS_WINDOW_MS;
  const coverageFloorRows =
    Number(env?.VALIDATOR_NOMINATOR_COUNTS_COVERAGE_FLOOR_ROWS) ||
    VALIDATOR_NOMINATOR_COUNTS_COVERAGE_FLOOR_ROWS;

  try {
    const row = (await db
      .prepare(VALIDATOR_NOMINATOR_COUNTS_COVERAGE_SQL)
      .bind(passWindowMs)
      .first()) as {
      latest: number | null;
      covered: number | null;
      total: number | null;
    } | null;
    const verdict = evaluateValidatorNominatorCountsStaleness({
      latestCapturedAtMs: row?.latest ?? null,
      coveredRows: countOrZero(row?.covered),
      totalRows: countOrZero(row?.total),
      nowMs: now(),
      thresholdMs,
      coverageFloorRows,
    });
    if (verdict.stale) {
      // The two faults get different wording on purpose -- "the producer
      // stopped" and "the producer is running and not finishing" send whoever
      // reads the alert to different places.
      const age =
        verdict.age_ms === null
          ? "no rows at all"
          : `${(verdict.age_ms / 3_600_000).toFixed(1)} h old`;
      const message =
        verdict.reason === "partial"
          ? `validator-nominator-counts lane truncated: the newest pass reached only ${verdict.covered_rows} hotkeys against a floor of ${verdict.coverage_floor_rows} (${verdict.total_rows} rows in the table, newest stamp ${age}) -- the capture is RECENT and PARTIAL, so /validators serves a nominator_count that is silently a pass old for every hotkey the scan never got to`
          : `validator-nominator-counts lane stalled: latest snapshot is ${age} (threshold ${thresholdMs / 3_600_000} h) -- /validators is serving nominator_count from a table nothing is refreshing`;
      await record(env as never, {
        error: new Error(message),
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
