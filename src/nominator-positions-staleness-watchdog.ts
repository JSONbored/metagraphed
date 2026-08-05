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
// Same shape as src/neurons-staleness-watchdog.ts deliberately: a single read,
// a pure rule, a summary rather than a throw, and one exception event per stale
// tick on the project's alert channel. Zero alerts is the correct steady state.
//
// ## COVERAGE IS COUNTED IN COLDKEYS HERE (#9530, #9533)
//
// The last of the four keyspace-scan lanes to get the coverage signal #9530
// added after a watchdog reading one `MAX(captured_at)` reported
// `ok | age=0.6h` over an account_balances table holding 147,000 rows -- 48% of
// the network. A fresh timestamp says when something last landed; it cannot say
// whether the whole thing landed.
//
// THE UNIT IS COLDKEYS BECAUSE THE PRUNE IS PER COLDKEY. This lane's writer
// (src/nominator-positions-d1-write.ts) deletes the positions a coldkey's own
// batch did not refresh, but only for coldkeys the batch CONTAINS -- an
// unstaked position genuinely stops existing, so that prune is correct. A
// coldkey absent from the pass entirely is left completely untouched, still
// carrying its previous stamp. So a scan that dies partway restamps the
// coldkeys it reached, leaves the rest behind a `MAX()` that just advanced, and
// /accounts/{ss58}/positions answers for those with a confident, silently
// pass-old position set.
//
// ROWS WOULD BE THE WRONG UNIT for the same reason it is on the neurons lane:
// coldkeys hold wildly different numbers of positions (122,836 rows across
// 23,668 coldkeys, so a mean of ~5 but a long tail), and a scan that died after
// the largest delegators could show high row coverage having missed most of the
// accounts. Coldkeys are what the scan iterates and what the prune is keyed on,
// so they are what a partial pass is partial IN.
//
// MEASURED 2026-08-05, production D1: 124,817 rows over three vintages --
// 122,836 rows / 23,668 coldkeys at the newest stamp, then 1,815/401 and 166/52
// older. Those 453 straggler coldkeys are the prune working as designed, and
// they are why coverage is counted over a WINDOW against an absolute floor
// rather than as a ratio of the table (which would read 98.1% and drift down
// forever as coldkeys stop delegating).
//
// The producer is the SAME 24h job that writes validator_nominator_counts --
// both tables carried the identical `captured_at` in that reading -- so the
// window and floor here are sized against that one scan, exactly as the sibling
// watchdog's are.
//
// COST: one walk of ~125k rows on an `8,38 * * * *` cron, 48 ticks a day, so
// ~6M D1 rows read a day.

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

/**
 * How many coldkeys a COMPLETE pass is expected to cover.
 *
 * 23,668, read off production D1 on 2026-08-05 as `COUNT(DISTINCT coldkey)` at
 * the newest `captured_at` -- every coldkey the SubtensorModule::Alpha scan
 * found holding at least one position.
 */
export const NOMINATOR_POSITIONS_EXPECTED_COLDKEYS = 23_668;

/**
 * How much of that a single pass must cover before it counts as complete.
 *
 * EIGHTY PERCENT (~18,934 coldkeys), the ratio the three sibling lanes use.
 *
 * The drift here runs the same direction as validator_nominator_counts and NOT
 * the same as account_balances, because this counts coldkeys holding a position
 * RIGHT NOW: it can genuinely shrink as delegators unstake. So a MARGINAL miss
 * on an otherwise-healthy lane means re-measure and lower this, not hunt for a
 * truncated pass -- a real mid-scan death lands far below, near a chunk
 * boundary. The 453 straggler coldkeys already in the table (see the module
 * header) are ~1.9%, nowhere near this floor.
 *
 * Overridable via NOMINATOR_POSITIONS_COVERAGE_FLOOR_COLDKEYS.
 */
export const NOMINATOR_POSITIONS_COVERAGE_FLOOR_RATIO = 0.8;

/** The floor the rule compares against, ~18,934 coldkeys. */
export const NOMINATOR_POSITIONS_COVERAGE_FLOOR_COLDKEYS = Math.round(
  NOMINATOR_POSITIONS_EXPECTED_COLDKEYS *
    NOMINATOR_POSITIONS_COVERAGE_FLOOR_RATIO,
);

/**
 * How far back from the newest stamp still counts as "the newest pass".
 *
 * FOUR HOURS, the same as validator_nominator_counts and for the same reason:
 * it is the SAME 24h producer scan writing both tables. Bounded from both ends
 * -- too small and the intra-pass spread reads as several partial passes (the
 * scan is ~4 minutes at the measured ~3,100 rows/sec, so this is three orders
 * of magnitude of headroom); too large and two consecutive passes merge into
 * one coverage count, letting a truncated pass on top of a complete one report
 * full coverage and restoring the bug. A sixth of the cadence sits well clear
 * of both.
 *
 * Overridable via NOMINATOR_POSITIONS_PASS_WINDOW_MS, which must be re-sized
 * against the poll interval if that interval ever shortens.
 */
export const NOMINATOR_POSITIONS_PASS_WINDOW_MS = 4 * 60 * 60 * 1000;

/**
 * One read, answering both questions: how fresh the newest pass is, and how
 * many coldkeys it actually reached.
 *
 * `total` is the coldkey count across ALL vintages -- context rather than the
 * rule. Read together the pair is the diagnosis: `covered` well under `total`
 * is a scan that died partway through the keyspace.
 */
const NOMINATOR_POSITIONS_COVERAGE_SQL =
  "SELECT COUNT(DISTINCT coldkey) AS total, MAX(captured_at) AS latest, " +
  "COUNT(DISTINCT CASE WHEN captured_at >= " +
  "(SELECT MAX(captured_at) FROM nominator_positions) - ? THEN coldkey END) " +
  "AS covered FROM nominator_positions";

export type NominatorPositionsStalenessReason =
  "no_rows" | "stale" | "partial" | null;

export interface NominatorPositionsStalenessVerdict {
  stale: boolean;
  reason: NominatorPositionsStalenessReason;
  age_ms: number | null;
  latest_captured_at: number | null;
  threshold_ms: number;
  /** Coldkeys the newest pass covered. The coverage signal itself. */
  covered_coldkeys: number;
  /** Coldkeys in the table across all vintages. Context, never the rule. */
  total_coldkeys: number;
  coverage_floor_coldkeys: number;
}

/** The rule alone, testable without a database or a clock. */
export function evaluateNominatorPositionsStaleness(input: {
  latestCapturedAtMs: number | null;
  coveredColdkeys: number;
  totalColdkeys: number;
  nowMs: number;
  thresholdMs: number;
  coverageFloorColdkeys: number;
}): NominatorPositionsStalenessVerdict {
  const {
    latestCapturedAtMs,
    coveredColdkeys,
    totalColdkeys,
    nowMs,
    thresholdMs,
    coverageFloorColdkeys,
  } = input;
  const base = {
    latest_captured_at: latestCapturedAtMs,
    threshold_ms: thresholdMs,
    covered_coldkeys: coveredColdkeys,
    total_coldkeys: totalColdkeys,
    coverage_floor_coldkeys: coverageFloorColdkeys,
  };
  if (latestCapturedAtMs === null) {
    // An empty table is a stall of infinite age, not a healthy quiet one --
    // and here it is also the CUTOVER state, before the revived lane has
    // posted anything. That is exactly the condition worth alerting on: an
    // empty hot tier means every positions read is still answering from the
    // frozen lakehouse export.
    return { ...base, stale: true, reason: "no_rows", age_ms: null };
  }
  const age = nowMs - latestCapturedAtMs;
  if (age > thresholdMs) {
    // Checked BEFORE coverage: if a whole pass has been missed, the coverage
    // number describes an old one and the headline is that the producer stopped.
    return { ...base, stale: true, reason: "stale", age_ms: age };
  }
  if (coveredColdkeys < coverageFloorColdkeys) {
    // Recent AND short -- a scan that died partway through the coldkey walk,
    // leaving the accounts it never reached behind a freshly advanced MAX().
    return { ...base, stale: true, reason: "partial", age_ms: age };
  }
  return { ...base, stale: false, reason: null, age_ms: age };
}

/** A null count over no rows, or a shim that stringifies, must land on 0 rather
 * than NaN -- a NaN compares false against the floor and would report a
 * half-scanned keyspace healthy. */
function countOrZero(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): { first(): Promise<unknown> };
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
  const passWindowMs =
    Number(env?.NOMINATOR_POSITIONS_PASS_WINDOW_MS) ||
    NOMINATOR_POSITIONS_PASS_WINDOW_MS;
  const coverageFloorColdkeys =
    Number(env?.NOMINATOR_POSITIONS_COVERAGE_FLOOR_COLDKEYS) ||
    NOMINATOR_POSITIONS_COVERAGE_FLOOR_COLDKEYS;

  try {
    const row = (await db
      .prepare(NOMINATOR_POSITIONS_COVERAGE_SQL)
      .bind(passWindowMs)
      .first()) as {
      latest: number | null;
      covered: number | null;
      total: number | null;
    } | null;
    const verdict = evaluateNominatorPositionsStaleness({
      latestCapturedAtMs: row?.latest ?? null,
      coveredColdkeys: countOrZero(row?.covered),
      totalColdkeys: countOrZero(row?.total),
      nowMs: now(),
      thresholdMs,
      coverageFloorColdkeys,
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
          ? `nominator-positions lane truncated: the newest pass covered only ${verdict.covered_coldkeys} of ${verdict.total_coldkeys} coldkeys against a floor of ${verdict.coverage_floor_coldkeys} (newest stamp ${age}) -- the capture is RECENT and PARTIAL, so /accounts/{ss58}/positions answers for every coldkey the scan never reached with a confident position set that is silently a pass old`
          : `nominator-positions lane stalled: latest snapshot is ${age} (threshold ${thresholdMs / 3_600_000} h) -- /accounts/{ss58}/positions is answering from a ledger nothing is refreshing`;
      await record(env as never, {
        error: new Error(message),
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
