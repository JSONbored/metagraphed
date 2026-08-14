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
// MEASURED 2026-08-05, production: 112,250 rows total across three vintages
// -- 112,245 at the newest stamp, then 1 and 4 rows at two older ones. Those
// five stragglers are the no-prune behaviour working as designed (a hotkey the
// latest scan did not re-send keeps its last known count), and they are why
// coverage is counted over a WINDOW rather than an exact stamp match.
//
// COST: one walk of ~112k rows on a `19,49 * * * *` cron, 48 ticks a day, so
// ~5.4M store rows read a day.

import { laneHealthStore } from "./lane-health-store.ts";
import { passWindowMs } from "./producer-cadence.ts";
import {
  countOrZero,
  numberOrNull,
  readStore,
  type ReadStoreDb,
} from "./read-store.ts";
import type { ValidatorNominatorCounts } from "../generated/db/types.ts";
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
 * 21,547, COUNTED ON CHAIN on 2026-08-14 rather than read off our own table:
 *
 *   prefix = twox128("SubtensorModule") ++ twox128("Alpha")
 *   state_getKeysPaged(prefix, 1000, last, finalizedHead), walked to exhaustion
 *   -> 120,253 entries over 121 pages, final page 253 (a SHORT page, so this is
 *      end-of-iteration and not a truncated walk)
 *   -> 21,547 distinct hotkeys, 24,605 distinct coldkeys
 *
 * ## WHY THIS WAS 112,245, AND WHY THAT NUMBER WAS THE BUG
 *
 * The old figure was "read off production on 2026-08-05 as the row count at the
 * newest `captured_at`". That was true when written and became false without
 * anything failing: the Alpha keyspace dropped ~84%, which the poller's own
 * scan floor was re-anchored for on 2026-08-13 (762,577 -> 120,314 there, also
 * by walking the map directly against two nodes). This constant was not
 * re-anchored alongside it, so the two halves of the same lane disagreed about
 * how big the network is.
 *
 * The result was an alarm that fired continuously on CORRECT data, saying
 * `/validators` "serves a nominator_count that is silently a pass old" while
 * the pass was in fact complete: it wrote 21,548 hotkeys against a chain that
 * has 21,547. A stale constant does not fail loudly, it fails plausibly -- the
 * same lesson the poller's floor comment records, one repo over.
 *
 * ## DO NOT RE-DERIVE THIS FROM THE TABLE
 *
 * `validator_nominator_counts` ACCUMULATES: it is keyed on (hotkey), and a
 * hotkey that loses its last nominator keeps its row rather than being deleted.
 * At the time of writing the table held 112,250 rows against those 21,547 live
 * hotkeys, which is why reading the table's row count reproduces exactly the
 * stale number this replaces. The expectation is a property of the CHAIN, so
 * measure it there.
 */
export const VALIDATOR_NOMINATOR_COUNTS_EXPECTED_HOTKEYS = 21_547;

/**
 * How much of that a single pass must cover before it counts as complete.
 *
 * EIGHTY PERCENT. This was originally placed against the chunking -- the sync
 * route caps a request at 25,000 rows, so at the old 112,245 expectation a full
 * pass was ~5 requests and a death partway landed near 25k / 50k / 75k / 100k,
 * which a ~89,800 floor caught in every case but the last.
 *
 * THAT REASONING NO LONGER APPLIES, and saying so matters more than keeping the
 * number. At the measured 21,547 a full pass fits in ONE request, so there are
 * no interior chunk boundaries for a death to land on: a pass either lands or
 * it does not, and a partial one now means the SCAN died rather than the upload.
 * 80% is kept because it still catches any shortfall over a fifth of the
 * population while sitting outside the noise band of ordinary churn -- but it is
 * now a plain tolerance, not a number derived from the chunk layout. If the
 * population grows back past ~25,000 the original argument returns on its own.
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
export const VALIDATOR_NOMINATOR_COUNTS_PASS_WINDOW_MS = passWindowMs(
  "validator_nominators",
  1 / 6,
);

/**
 * One read, answering both questions: how fresh the newest pass is, and how
 * many hotkeys it actually reached.
 *
 * `total` is not used by the rule -- it rides along free on the same walk and
 * is what tells an operator how many older-vintage rows are sitting underneath
 * a partial pass.
 */
export const VALIDATOR_NOMINATOR_COUNTS_COVERAGE_SQL =
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

/**
 * The single row the coverage read returns.
 *
 * `latest` is typed through the GENERATED column type, so a stamp that changes
 * type in Neon changes here rather than silently arriving as something else.
 * The counts are `string | number` for the driver's reason, not the column's:
 * COUNT() is BIGINT and node-postgres hands a bigint back as a string whenever
 * it is not exactly representable. Every member is nullable because each
 * subselect answers null on an empty table.
 */
interface ValidatorNominatorCountsCoverageRow {
  latest: ValidatorNominatorCounts["captured_at"] | null;
  covered: string | number | null;
  total: string | number | null;
}

export interface ValidatorNominatorCountsStalenessDeps {
  // No `ctx`. readStore opens and closes a connection per operation precisely
  // so the tier readers and the cron watchdogs -- none of which hold an
  // ExecutionContext -- can follow their table without one. A dep that only a
  // test could ever supply is a dep that hides an unreachable production path.
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
  // Follows validator_nominator_counts to whichever store owns it (#10086),
  // through readStore -- the same selector its three sibling watchdogs use. A
  // watchdog left on the abandoned store reports the frozen copy's staleness,
  // which is the alarm firing about the wrong thing entirely.
  //
  // NOT observationsReadDb, which this briefly used and which cannot serve this
  // lane at all. It gates on the OBSERVATION family (surface_checks and four
  // others) rather than on this table, so the flag that would move this lane is
  // not the flag it reads; it requires an ExecutionContext to park its
  // connection teardown on, and handleScheduled passes the cron watchdogs none,
  // so it answered `undefined` on every tick; and its adapter exposes only
  // `all()`, so the `.first()` below threw `not a function` even when a ctx was
  // threaded in by hand. Each of those alone is silent -- the lane simply stops
  // reporting, and an absent verdict reads as health.
  const db = readStore(env, ["validator_nominator_counts"]) as unknown as
    ReadStoreDb | undefined;
  if (!db?.first) return { ok: false, reason: "no store bound" };

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
    const row = await db.first<ValidatorNominatorCountsCoverageRow>(
      VALIDATOR_NOMINATOR_COUNTS_COVERAGE_SQL,
      [passWindowMs],
    );
    const verdict = evaluateValidatorNominatorCountsStaleness({
      latestCapturedAtMs: numberOrNull(row?.latest),
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
    await recordLaneVerdict(laneHealthStore(env, deps.laneHealthDb), {
      lane: "validator-nominator-counts-staleness",
      verdict: verdict.stale ? "stale" : "ok",
      age_ms: verdict.age_ms,
      detail: verdict.reason ?? null,
      checked_at: now(),
    });
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
