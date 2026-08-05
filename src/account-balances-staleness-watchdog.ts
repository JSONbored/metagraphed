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
// Same shape as src/nominator-positions-staleness-watchdog.ts deliberately: a
// single read, a pure rule, a summary rather than a throw, and one exception
// event per stale tick on the project's alert channel. Zero alerts is the
// correct steady state.
//
// ## A FRESH TIMESTAMP IS NOT A COMPLETE PASS (#9530)
//
// This shipped watching one number, `MAX(captured_at)`, and that number cannot
// see the failure it was next asked about. Measured on production D1,
// 2026-08-05 06:04Z: `lane_health` carried
// `account-balances-staleness | ok | age=0.6h`, while
//
//     SELECT captured_at, COUNT(*) FROM account_balances GROUP BY captured_at
//     -- 2026-08-05T05:27:16.083Z | 147000     (one row, the whole table)
//
// held 147,000 accounts -- roughly 48% of the network, the committed remains of
// a streaming pass that died partway. The stamp on those rows was genuinely
// 36 minutes old, so the rule was applied correctly and returned the wrong
// answer: one chunk of a pass that died at 48% looks exactly as fresh as a
// complete pass. The alarm built to catch a DEAD lane could not see a HALF-DEAD
// one. #9511 measured what that costs downstream -- the second-largest free
// balance on the network, 737,821 TAO, live on chain and simply absent from the
// ledger, so a `free_tao` ranking off this table is well-formed and quietly
// missing its #2.
//
// The repair is not a tighter threshold. Truncation is only caught by a
// threshold through the accident of enough time passing afterwards, which is
// the bug restated, not a fix: the half-loaded table above would have been
// reported `ok` for another eleven hours.
//
// ## WHAT IS COUNTED, AND WHY IT IS THIS AND NOT THE OBVIOUS TWO
//
// The measure added here is THE NUMBER OF ACCOUNTS THE NEWEST PASS ACTUALLY
// WROTE, against a floor sized to the network. Two other candidates lose to it
// on specifics rather than on taste:
//
//   A whole-table `COUNT(*)` floor catches the state above and nothing after
//   it. This writer never prunes (see src/account-balances-d1-write.ts on why
//   deleting an absent account would delete the wallets that emptied), so once
//   a complete pass has landed, a later pass that dies at 48% CANNOT shrink the
//   table -- it upserts half the rows to a new stamp and leaves the other half
//   at the old one. `COUNT(*)` still reads the full network and reports fine,
//   on exactly the failure this file exists for. That blindness arrives the
//   moment the lane starts working, which is to say almost immediately.
//
//   A producer-published completeness marker (a per-pass row count or terminal
//   sentinel, the infra-side option #9511 weighs) is the right answer for the
//   SERVING guard and the wrong one here, for one reason: a pass that dies is a
//   pass that never sends its marker. The watchdog would then be inferring the
//   fault from an ABSENCE of report -- which is the staleness check it already
//   has, and which is precisely what answered `ok` above, because the truncated
//   pass's committed chunk was recent. A watchdog whose job is to catch a
//   producer failing cannot take that producer's word for whether it failed;
//   every alarm in this family reads the source or the served object directly
//   for that reason. (This is complementary to #9511's serving guard, not a
//   substitute: this one reports the fault, that one refuses to rank over it.)
//
// Counting the newest pass's own rows beats both because it measures the PASS
// rather than the accumulation. It fires on 147,000 whether the table was empty
// beforehand (147,000 written) or already full (147,000 refreshed out of
// ~306,000), and it never divides by the table size, so it does not drift as
// emptied-and-never-refunded accounts pile up carrying old stamps forever.
//
// COST, since this trades an index seek for a scan. `COUNT(*)` plus the
// conditional sum is one walk of the table, ~306k rows, on a `4,34 * * * *`
// cron -- 48 ticks a day, ~15M D1 rows read a day. That sits inside the
// included allowance and is the price of the only signal that would have fired
// on the case above.

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

/**
 * How many accounts a COMPLETE pass is expected to write.
 *
 * The producer walks System::Account -- 542,618 entries at its own last live
 * measurement (2026-07-19), per migrations/d1/0017_account_balances.sql -- and
 * SKIPS every account whose free and reserved are both zero, so a full pass
 * lands the nonzero-balance subset of that, ~306,000 accounts (2026-08-05).
 *
 * Stated as the measurement rather than as a bound, because the floor below is
 * what the rule actually uses and is sized so that being wrong about this
 * number cannot make the alarm wrong in the dangerous direction.
 */
export const ACCOUNT_BALANCES_EXPECTED_ACCOUNTS = 306_000;

/**
 * How much of that a single pass must cover before it counts as complete.
 *
 * EIGHTY PERCENT, and the slack is deliberate on both sides:
 *
 *   It cannot false-fire on a working lane. A complete pass writes the whole
 *   nonzero subset, so the only way to land under this floor is to not finish.
 *   The 20% gap absorbs both ordinary churn in the account population and the
 *   possibility that ACCOUNT_BALANCES_EXPECTED_ACCOUNTS above is an
 *   overestimate -- if the true subset is nearer the raw 542,618, this floor is
 *   merely slacker still, never tighter. That is the #9301 sizing rule: an
 *   alarm that fires on a lane which is working stops being read.
 *
 *   It still catches the case it was built for decisively. The measured
 *   truncation wrote 147,000, which is 48% of the expectation and 60% of the
 *   floor -- not a near miss in either direction.
 *
 * The gap it does NOT catch is a pass that dies between 80% and 100%, and only
 * while the table has never held a complete pass. Once one has, a later partial
 * refreshes fewer rows than it and is caught here anyway.
 */
export const ACCOUNT_BALANCES_COVERAGE_FLOOR_RATIO = 0.8;

/** The floor the rule compares against, ~244,800 rows. */
export const ACCOUNT_BALANCES_COVERAGE_FLOOR_ROWS = Math.round(
  ACCOUNT_BALANCES_EXPECTED_ACCOUNTS * ACCOUNT_BALANCES_COVERAGE_FLOOR_RATIO,
);

/**
 * How far back from the newest stamp still counts as "the newest pass".
 *
 * TWO HOURS, and this one is bounded from both ends rather than being slack:
 *
 *   Too SMALL and a producer that stamps each request instead of each pass
 *   reads as ~22 partial passes, and the alarm fires forever on a healthy lane.
 *   Today a pass carries ONE stamp -- the 147,000 rows measured above arrived
 *   across ~6 requests and shared a single `captured_at` to the millisecond --
 *   so this window is pure headroom against that changing.
 *
 *   Too LARGE and two consecutive passes merge into one coverage count, so a
 *   truncated pass sitting on top of the previous complete one sums to full
 *   coverage and reports fine -- reintroducing exactly this file's bug. The
 *   producer's `ACCOUNT_BALANCES_POLL_SECS` is 21600 (six hours), so the window
 *   must stay well under that; two is a third of it.
 *
 * Overridable via ACCOUNT_BALANCES_PASS_WINDOW_MS, which must be re-sized
 * against the poll interval if that interval ever shortens.
 */
export const ACCOUNT_BALANCES_PASS_WINDOW_MS = 2 * 60 * 60 * 1000;

/**
 * One read, answering both questions: how fresh the newest pass is, and how
 * much of the network it actually covered.
 *
 * `covered` counts only rows stamped within ACCOUNT_BALANCES_PASS_WINDOW_MS of
 * the newest stamp -- the rows THIS pass wrote -- rather than the whole table,
 * which is the distinction the module header exists about. `total` is not used
 * by the rule; it rides along free on the same walk and is what tells an
 * operator how much older data is sitting underneath a partial pass.
 */
const ACCOUNT_BALANCES_COVERAGE_SQL =
  "SELECT COUNT(*) AS total, MAX(captured_at) AS latest, " +
  "SUM(CASE WHEN captured_at >= " +
  "(SELECT MAX(captured_at) FROM account_balances) - ? THEN 1 ELSE 0 END) " +
  "AS covered FROM account_balances";

export type AccountBalancesStalenessReason =
  "no_rows" | "stale" | "partial" | null;

export interface AccountBalancesStalenessVerdict {
  stale: boolean;
  reason: AccountBalancesStalenessReason;
  age_ms: number | null;
  latest_captured_at: number | null;
  threshold_ms: number;
  /** Accounts the newest pass wrote. The coverage signal itself. */
  covered_rows: number;
  /** Accounts in the table across all vintages. Context, never the rule. */
  total_rows: number;
  coverage_floor_rows: number;
}

/** The rule alone, testable without a database or a clock. */
export function evaluateAccountBalancesStaleness(input: {
  latestCapturedAtMs: number | null;
  coveredRows: number;
  totalRows: number;
  nowMs: number;
  thresholdMs: number;
  coverageFloorRows: number;
}): AccountBalancesStalenessVerdict {
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
    // and here it is also the CUTOVER state, before the revived lane has
    // posted anything. That is exactly the condition worth alerting on: an
    // empty table means every top-holders read is still answering from the
    // frozen 2026-08-02 artifact.
    return { ...base, stale: true, reason: "no_rows", age_ms: null };
  }
  const age = nowMs - latestCapturedAtMs;
  if (age > thresholdMs) {
    // Checked BEFORE coverage: if nothing has run in half a day, the coverage
    // number describes an old pass and the headline is that the producer
    // stopped, not how much its last attempt managed to write.
    return { ...base, stale: true, reason: "stale", age_ms: age };
  }
  if (coveredRows < coverageFloorRows) {
    // Recent AND short -- the discrimination this rule exists for. The pass ran
    // and did not finish, so the table is a stitched mix of vintages that reads
    // as fresh from its MAX() alone.
    return { ...base, stale: true, reason: "partial", age_ms: age };
  }
  return { ...base, stale: false, reason: null, age_ms: age };
}

/** D1 counts arrive as numbers, but a null SUM over no rows and a shim that
 * stringifies both have to land on 0 rather than NaN -- a NaN would compare
 * false against the floor and report the truncated table healthy. */
function countOrZero(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): { first(): Promise<unknown> };
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
  const passWindowMs =
    Number(env?.ACCOUNT_BALANCES_PASS_WINDOW_MS) ||
    ACCOUNT_BALANCES_PASS_WINDOW_MS;
  const coverageFloorRows =
    Number(env?.ACCOUNT_BALANCES_COVERAGE_FLOOR_ROWS) ||
    ACCOUNT_BALANCES_COVERAGE_FLOOR_ROWS;

  try {
    const row = (await db
      .prepare(ACCOUNT_BALANCES_COVERAGE_SQL)
      .bind(passWindowMs)
      .first()) as {
      latest: number | null;
      covered: number | null;
      total: number | null;
    } | null;
    const verdict = evaluateAccountBalancesStaleness({
      latestCapturedAtMs: row?.latest ?? null,
      coveredRows: countOrZero(row?.covered),
      totalRows: countOrZero(row?.total),
      nowMs: now(),
      thresholdMs,
      coverageFloorRows,
    });
    if (verdict.stale) {
      // The two faults get different wording on purpose. They are read in
      // PostHog by whoever is on the other end of the alert, and "the producer
      // stopped" and "the producer is running and not finishing" send that
      // person to different places.
      const age =
        verdict.age_ms === null
          ? "no rows at all"
          : `${(verdict.age_ms / 3_600_000).toFixed(1)} h old`;
      const message =
        verdict.reason === "partial"
          ? `account-balances lane truncated: the newest pass covered only ${verdict.covered_rows} accounts against a floor of ${verdict.coverage_floor_rows} (${verdict.total_rows} rows in the table, newest stamp ${age}) -- the capture is RECENT and PARTIAL, so /accounts/top-holders ranks free_tao over whatever fraction landed and a real top holder the pass never reached is silently absent, not merely stale`
          : `account-balances lane stalled: latest snapshot is ${age} (threshold ${thresholdMs / 3_600_000} h) -- /accounts/top-holders is answering from a free_tao column nothing is refreshing`;
      await record(env as never, {
        error: new Error(message),
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
