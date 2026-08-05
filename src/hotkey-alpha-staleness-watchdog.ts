// The alarm for the hotkey-alpha pool ledger (#9576).
//
// The twin of src/account-balances-staleness-watchdog.ts, and the ledger that
// went without one. #9502 listed a staleness watchdog in its own shape; #9512
// landed the table and the writer and the watchdog never followed. Measured
// 2026-08-05: `hotkey_alpha` held 0 rows, `hotkey_alpha_passes` held 0 passes,
// and `lane_health` had never carried a row for this lane -- so the ledger three
// surfaces depend on was empty, and the only way to learn that was to query it
// by hand.
//
// WHY AN EMPTY LEDGER IS QUIET HERE RATHER THAN LOUD. Every reader of this table
// declines deliberately when it cannot prove a complete pass:
// `/accounts/top-holders` falls back to the frozen 2026-08-02 materialization
// for `delegated_tao`/`total_tao` (#9545), and
// `/api/v1/subnets/{netuid}/holders` answers `degraded.reason:
// pool_totals_unproven` (#9557). Those declines are correct -- they are what
// stops a partial pool ledger producing a plausible wrong ranking. But from
// outside, a correct decline and a producer that died a month ago are the same
// response. That is precisely the state #9478's watchdog was built after: the
// previous silently-dead lane was found by a caller reading a timestamp.
//
// The reasoning about WHAT to count is inherited from
// src/account-balances-staleness-watchdog.ts and deliberately not re-derived
// here. Both points hold for this ledger unchanged:
//
//   - A whole-table `COUNT(*)` floor goes blind the moment one complete pass
//     lands. This writer never prunes either (migrations/d1/0019 says why: the
//     producer skips a genuine zero pool, so absence carries no meaning), so a
//     later pass that dies partway upserts some rows to a new stamp and leaves
//     the rest at the old one -- the row count never drops.
//   - The producer's own completeness marker (`hotkey_alpha_passes`) is the
//     right input for the SERVING gate and the wrong one for the alarm: a pass
//     that dies is a pass that never writes its `completed_at`, so keying on it
//     would infer the fault from an absence of report, which is the staleness
//     check this already has.
//
// So the rule counts the rows the NEWEST pass wrote, against a floor.
//
// ## THE FLOOR IS DERIVED, NOT DECLARED -- the one real divergence from the twin
//
// #9478 could state its expectation as a constant (~306,000 nonzero accounts)
// because the producer's population is the network's. This sink's population is
// not: #9560 narrowed it to store only the pools some position actually
// REFERENCES, so a complete pass lands the ~17,902 distinct (hotkey, netuid)
// pairs `nominator_positions` names -- not the ~762,577 `TotalHotkeyAlpha`
// entries the producer walks. That number moves with the position ledger, so a
// constant here would rot silently in whichever direction positions drift, and
// the dangerous direction (a floor that has quietly grown too low to fire) is
// invisible.
//
// Reading it from `nominator_positions` in the same statement makes the floor
// track the sink's own predicate by construction -- the expectation and the
// filter are then the same fact rather than two copies of it. It is cheap
// because #9558 added the (hotkey, netuid) index that makes the DISTINCT an
// index-only walk.
//
// AND AN EMPTY POSITION LEDGER SKIPS THE COVERAGE CLAUSE rather than dividing by
// nothing. A floor of zero would mark every pass complete, including no pass at
// all; and `nominator_positions` already has its own alarm
// (`nominator-positions-staleness`), so restating its verdict here would put two
// lanes' names on one fault and send whoever reads it to the wrong producer.

import { recordExceptionEvent } from "./usage-telemetry.ts";
import { recordLaneVerdict, type LaneHealthDb } from "./lane-health.ts";

/**
 * How old the pool ledger may get before this is a stall.
 *
 * FORTY-EIGHT HOURS, four times the twin's twelve, because the producer behind
 * it runs four times less often: `HOTKEY_ALPHA_POLL_SECS` defaults to 86400
 * (24 h) against `account_balances`' 21600 (6 h). Two full cadences of slack, so
 * it cannot fire until a pass has genuinely been skipped -- and the pass itself
 * is a full TotalHotkeyAlpha walk that is buffered end to end before anything is
 * posted, so a healthy lane's age swings across the whole 24 h interval plus the
 * walk.
 *
 * This is the #9301 sizing rule: a six-hour bound was once set against a 24-hour
 * producer and alerted for three quarters of every day on a lane that was
 * working, which is how an alarm stops being read.
 *
 * Overridable via HOTKEY_ALPHA_STALENESS_THRESHOLD_MS so the number can follow
 * the Container's cadence without a code deploy.
 */
export const HOTKEY_ALPHA_STALENESS_THRESHOLD_MS = 48 * 60 * 60 * 1000;

/**
 * How much of the referenced pool set a single pass must cover to count.
 *
 * EIGHTY PERCENT, the twin's ratio and for its reasons: a complete pass writes
 * every referenced pair, so the only way under this floor is to not finish, and
 * the 20% gap absorbs ordinary churn between the two ledgers' capture times --
 * `nominator_positions` and `hotkey_alpha` refresh on their own clocks, so the
 * pairs one names and the pools the other stored are never a same-instant match.
 */
export const HOTKEY_ALPHA_COVERAGE_FLOOR_RATIO = 0.8;

/**
 * How far back from the newest stamp still counts as "the newest pass".
 *
 * SIX HOURS. The producer stamps a pass ONCE at scan start and repeats that
 * stamp across every chunk (migrations/d1/0021_hotkey_alpha_passes.sql), so
 * today a pass is a single `captured_at` and this window is pure headroom
 * against that changing. It is bounded above by the 24 h poll interval -- two
 * consecutive passes must never merge into one coverage count, or a truncated
 * pass sitting on a complete one sums to full coverage and reports fine, which
 * is the bug reintroduced. Six is a quarter of the interval.
 */
export const HOTKEY_ALPHA_PASS_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * One read answering three questions: how fresh the newest pass is, how many
 * rows it wrote, and how many pools the position ledger currently references.
 *
 * `covered` counts only rows stamped within HOTKEY_ALPHA_PASS_WINDOW_MS of the
 * newest stamp -- what THIS pass wrote -- rather than the whole table. `total`
 * rides along free and tells an operator how much older data sits underneath a
 * partial pass; it is never the rule.
 */
const HOTKEY_ALPHA_COVERAGE_SQL =
  "SELECT (SELECT COUNT(*) FROM hotkey_alpha) AS total," +
  " (SELECT MAX(captured_at) FROM hotkey_alpha) AS latest," +
  " (SELECT SUM(CASE WHEN captured_at >=" +
  " (SELECT MAX(captured_at) FROM hotkey_alpha) - ? THEN 1 ELSE 0 END)" +
  " FROM hotkey_alpha) AS covered," +
  " (SELECT COUNT(*) FROM (SELECT DISTINCT hotkey, netuid" +
  " FROM nominator_positions)) AS referenced";

export type HotkeyAlphaStalenessReason = "no_rows" | "stale" | "partial" | null;

export interface HotkeyAlphaStalenessVerdict {
  stale: boolean;
  reason: HotkeyAlphaStalenessReason;
  age_ms: number | null;
  latest_captured_at: number | null;
  threshold_ms: number;
  /** Pool totals the newest pass wrote. The coverage signal itself. */
  covered_rows: number;
  /** Pool totals across all vintages. Context, never the rule. */
  total_rows: number;
  /** Distinct (hotkey, netuid) pairs `nominator_positions` names right now. */
  referenced_pairs: number;
  /** The derived floor, or null when there is nothing to derive it from. */
  coverage_floor_rows: number | null;
}

/** The rule alone, testable without a database or a clock. */
export function evaluateHotkeyAlphaStaleness(input: {
  latestCapturedAtMs: number | null;
  coveredRows: number;
  totalRows: number;
  referencedPairs: number;
  nowMs: number;
  thresholdMs: number;
  coverageFloorRatio: number;
}): HotkeyAlphaStalenessVerdict {
  const {
    latestCapturedAtMs,
    coveredRows,
    totalRows,
    referencedPairs,
    nowMs,
    thresholdMs,
    coverageFloorRatio,
  } = input;
  // Null rather than 0 when nothing references a pool: "we did not measure a
  // floor" and "the floor is zero" reach opposite conclusions about the same
  // pass, and only the first is true.
  const coverageFloorRows =
    referencedPairs > 0
      ? Math.round(referencedPairs * coverageFloorRatio)
      : null;
  const base = {
    latest_captured_at: latestCapturedAtMs,
    threshold_ms: thresholdMs,
    covered_rows: coveredRows,
    total_rows: totalRows,
    referenced_pairs: referencedPairs,
    coverage_floor_rows: coverageFloorRows,
  };
  if (latestCapturedAtMs === null) {
    // An empty table is a stall of infinite age, not a healthy quiet one. It is
    // also the state this lane has been in since the sink shipped, with every
    // reader declining and nothing saying why.
    return { ...base, stale: true, reason: "no_rows", age_ms: null };
  }
  const age = nowMs - latestCapturedAtMs;
  if (age > thresholdMs) {
    // Checked BEFORE coverage: if nothing has run in two days, the coverage
    // number describes an old pass and the headline is that the producer
    // stopped, not how much its last attempt wrote.
    return { ...base, stale: true, reason: "stale", age_ms: age };
  }
  if (coverageFloorRows !== null && coveredRows < coverageFloorRows) {
    // Recent AND short -- the discrimination this rule exists for. A pool total
    // that never arrived prices every position naming it against nothing, so
    // the holders it feeds come out merely too LOW rather than absent.
    return { ...base, stale: true, reason: "partial", age_ms: age };
  }
  // Reached with coverageFloorRows null when the position ledger is empty: the
  // freshness verdict still stands on its own, and the coverage clause is
  // declined rather than answered against a floor of nothing.
  return { ...base, stale: false, reason: null, age_ms: age };
}

/** D1 counts arrive as numbers, but a null SUM over no rows and a shim that
 * stringifies both have to land on 0 rather than NaN -- a NaN would compare
 * false against the floor and report a truncated ledger healthy. */
function countOrZero(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): { first(): Promise<unknown> };
  };
}

export interface HotkeyAlphaStalenessDeps {
  /** Injectable durable sink, so a test can assert the verdict was RECORDED and
   * not merely notified. */
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
export async function runHotkeyAlphaStalenessWatchdog(
  env: Record<string, unknown> | null | undefined,
  deps: HotkeyAlphaStalenessDeps = {},
): Promise<Record<string, unknown>> {
  const now = deps.now ?? Date.now;
  const record = deps.recordException ?? recordExceptionEvent;
  const db = env?.METAGRAPH_HEALTH_DB as D1Like | undefined;
  if (!db?.prepare) return { ok: false, reason: "d1 binding unavailable" };

  const thresholdMs =
    Number(env?.HOTKEY_ALPHA_STALENESS_THRESHOLD_MS) ||
    HOTKEY_ALPHA_STALENESS_THRESHOLD_MS;
  const passWindowMs =
    Number(env?.HOTKEY_ALPHA_PASS_WINDOW_MS) || HOTKEY_ALPHA_PASS_WINDOW_MS;
  const coverageFloorRatio =
    Number(env?.HOTKEY_ALPHA_COVERAGE_FLOOR_RATIO) ||
    HOTKEY_ALPHA_COVERAGE_FLOOR_RATIO;

  try {
    const row = (await db
      .prepare(HOTKEY_ALPHA_COVERAGE_SQL)
      .bind(passWindowMs)
      .first()) as {
      latest: number | null;
      covered: number | null;
      total: number | null;
      referenced: number | null;
    } | null;
    const verdict = evaluateHotkeyAlphaStaleness({
      latestCapturedAtMs: row?.latest ?? null,
      coveredRows: countOrZero(row?.covered),
      totalRows: countOrZero(row?.total),
      referencedPairs: countOrZero(row?.referenced),
      nowMs: now(),
      thresholdMs,
      coverageFloorRatio,
    });
    if (verdict.stale) {
      // The three faults get different wording on purpose. They are read in
      // PostHog by whoever is on the other end, and "never started", "stopped"
      // and "running but not finishing" send that person to different places.
      const age =
        verdict.age_ms === null
          ? "no rows at all"
          : `${(verdict.age_ms / 3_600_000).toFixed(1)} h old`;
      const message =
        verdict.reason === "partial"
          ? `hotkey-alpha lane truncated: the newest pass wrote only ${verdict.covered_rows} pool totals against a floor of ${verdict.coverage_floor_rows} derived from the ${verdict.referenced_pairs} (hotkey, netuid) pairs nominator_positions references (${verdict.total_rows} rows in the table, newest stamp ${age}) -- the capture is RECENT and PARTIAL, so every position naming a pool the pass never reached prices against nothing and its holder is UNDERSTATED rather than missing`
          : `hotkey-alpha lane ${verdict.reason === "no_rows" ? "has never landed a pass" : "stalled"}: ${age} (threshold ${thresholdMs / 3_600_000} h) -- /accounts/top-holders is answering delegated_tao/total_tao from the frozen 2026-08-02 materialization and /subnets/{netuid}/holders is declining every request with pool_totals_unproven`;
      await record(env as never, {
        error: new Error(message),
        route: "watchdog:hotkey-alpha-staleness",
        errorCode: "stale_lane",
      }).catch(() => false);
    }
    // The DURABLE record, written every tick rather than only when stale
    // (#9330/#9340). PostHog stays the notification path; it is not the record,
    // because a dropped $exception is indistinguishable from a lane that was
    // fine. Writing every tick is also what makes "the watchdog stopped
    // running" visible at all. Never throws -- see recordLaneVerdict.
    await recordLaneVerdict(
      deps.laneHealthDb ?? (env?.METAGRAPH_HEALTH_DB as never),
      {
        lane: "hotkey-alpha-staleness",
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
