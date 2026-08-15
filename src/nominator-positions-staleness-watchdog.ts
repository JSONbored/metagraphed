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
// MEASURED 2026-08-05, production: 124,817 rows over three vintages --
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
// ~6M store rows read a day.

import { laneHealthStore } from "./lane-health-store.ts";
import { missedTicksMs, passWindowMs } from "./producer-cadence.ts";
import { recordExceptionEvent } from "./usage-telemetry.ts";
import { recordLaneVerdict, type LaneHealthDb } from "./lane-health.ts";
import {
  countOrZero,
  numberOrNull,
  readStore,
  type ReadStoreDb,
} from "./read-store.ts";
import type { NominatorPositions } from "../generated/db/types.ts";
import { requireFullScanValue } from "./lane-table-topology.ts";
import type { StoreEnv } from "./read-store.ts";
import type { TelemetryEnv } from "./usage-telemetry.ts";

/**
 * What this module reads from its environment, and nothing else.
 *
 * Named rather than left as `Record<string, unknown>` (#11339): a Record
 * READS as loose but is not, because `Env` is an interface and TypeScript
 * never gives interfaces implicit index signatures -- so every caller
 * holding a real `Env` wrote `env as unknown as Record<string, unknown>`
 * to get past it. Listing the keys costs nothing and states the contract.
 */
type NominatorPositionsStalenessWatchdogEnv = StoreEnv &
  TelemetryEnv & {
    NOMINATOR_POSITIONS_COVERAGE_FLOOR_COLDKEYS?: unknown;
    NOMINATOR_POSITIONS_PASS_WINDOW_MS?: unknown;
    NOMINATOR_POSITIONS_STALENESS_THRESHOLD_MS?: unknown;
  };

/**
 * How old the ledger may get before this is a stall.
 *
 * THIRTY-SIX HOURS, not the neurons lane's 45 minutes, and the difference is the
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
 * CORRECTED AGAIN, from 30h, and for the same reason one level finer: 30h was
 * "one missed pass plus slack for the scan itself (~4 minutes) and cron
 * jitter", and the producer's real worst case is far wider than jitter.
 * Measured against production 2026-08-15 over 29 consecutive pass gaps:
 *
 *     min 0.66h    p90 24.41h    MAX 34.57h
 *     4 gaps exceed the 24h cadence; 2 exceed the 30h bound
 *
 * A gap of 34.6h is not a skipped pass -- a skipped pass on a daily poller is
 * ~48h. It is the pass running LATE, which is what a container running its
 * lanes sequentially does when something ahead of this one runs long. The
 * premise "a healthy lane presents an age anywhere in [0h, 24h+scan]" is
 * therefore measurably false; the observed range is [0.66h, 34.57h].
 *
 * What that cost, from `lane_health` over 535 ticks: 519 `ok` (worst age
 * 29.95h, just under the old bound) and **9 age-based `stale` verdicts between
 * 30.02h and 33.02h**, every one of them from the two late passes above rather
 * than from a producer that stopped. An alarm firing on a working lane 3% of
 * the time is the #9301 failure this constant has already been corrected for
 * once -- corrected then from 6h, and still left under the real ceiling.
 *
 * THIRTY-SIX HOURS: 1.5 ticks, clearing the measured 34.57h maximum by ~1.4h.
 * The cost is stated rather than hidden -- a writer that stops entirely is now
 * reported six hours later than before, at a day and a half rather than a day
 * and a quarter. Against a daily producer that is still well inside "caught
 * the same day", and it buys an alarm that means something when it fires.
 *
 * NOT a suppression of a known-bad state (which #9475 rightly refuses): the
 * lane is healthy in every one of these cases, and the bound was describing a
 * cadence the producer does not have.
 *
 * Overridable per-deployment via NOMINATOR_POSITIONS_STALENESS_THRESHOLD_MS so
 * the number can follow the Container's cadence without a code deploy.
 */
export const NOMINATOR_POSITIONS_STALENESS_THRESHOLD_MS = missedTicksMs(
  "validator_nominators",
  1.5,
);

/**
 * How many coldkeys a COMPLETE pass is expected to cover.
 *
 * 21,263, COUNTED ON CHAIN on 2026-08-14 rather than read off our own table:
 *
 *   prefix = twox128("SubtensorModule") ++ twox128("Alpha")
 *   state_getKeysPaged(prefix, 1000, last, finalizedHead), walked to exhaustion
 *   -> 120,253 entries over 121 pages, final page 253 (a SHORT page, so this is
 *      end-of-iteration and not a truncated walk)
 *   -> 108,671 with netuid != 0, of which ZERO carry shares == 0
 *   -> 21,263 distinct coldkeys
 *
 * This lane's sink stores netuid != 0 with shares > 0, so that last figure is
 * the population a complete pass covers, measured against the source rather
 * than inferred from the sink.
 *
 * ## THIS ONE DRIFTED, IT DID NOT ROT
 *
 * The previous 23,668 was "read off production on 2026-08-05 as
 * `COUNT(DISTINCT coldkey)` at the newest `captured_at`" -- correctly scoped to
 * ONE pass, so it never had the accumulation bug its siblings did (#11165,
 * #11167 both re-anchored constants that had been read over a whole table that
 * never prunes). It simply fell ~10% behind the network in nine days, which is
 * the shrink direction the ratio's comment below already anticipates.
 *
 * Re-measuring is therefore routine maintenance here, not a defect fix, and the
 * rule it feeds did its job in the meantime: the pass that prompted this covered
 * 9,254 coldkeys, far below the floor rather than marginally under it, and was
 * correctly read as a truncated pass rather than as drift.
 *
 * Measure it on CHAIN when re-anchoring. `nominator_positions` accumulates --
 * `COUNT(DISTINCT coldkey)` over the whole table read 28,650 at the time of
 * writing against those 21,263 live coldkeys, and that figure is the one the
 * alarm text reports as context.
 */
export const NOMINATOR_POSITIONS_EXPECTED_COLDKEYS = 21_263;

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
export const NOMINATOR_POSITIONS_PASS_WINDOW_MS = passWindowMs(
  "validator_nominators",
  1 / 6,
);

/**
 * One read, answering both questions: how fresh the newest pass is, and how
 * many coldkeys it actually reached.
 *
 * `total` is the coldkey count across ALL vintages -- context rather than the
 * rule. Read together the pair is the diagnosis: `covered` well under `total`
 * is a scan that died partway through the keyspace.
 */
/**
 * The producer this rule is about.
 *
 * `nominator_positions` has TWO writers and they are not interchangeable.
 * `alpha` is the 24h SubtensorModule::Alpha full scan whose completeness this
 * alarm exists to police. `self-stake` is a targeted top-up that fills the gap
 * that scan cannot reach -- an owner's own self-stake -- and it writes a
 * legitimate SUBSET with its own fresh `captured_at`, pruning only its own
 * source.
 *
 * Unscoped, `MAX(captured_at)` is therefore whichever producer ran last, and a
 * healthy self-stake run makes the full scan look truncated. Measured
 * 2026-08-14: self-stake wrote 9,254 coldkeys at 05:42 and reported
 * `ok -- 37542 scanned, 33719 written, 0 error(s)`, while the alpha scan's own
 * newest pass held 19,870 coldkeys and was marked complete in
 * `nominator_positions_passes`. The alarm read the 9,254 as the newest pass and
 * reported /accounts/{ss58}/positions as serving silently-partial data for
 * hours, on a lane where BOTH producers had succeeded.
 */
// DERIVED from the table's declared topology (#11183), not restated here.
//
// `src/lane-table-topology.ts` is where "this table has two producers and
// `alpha` is the full scan" is stated once, checked against the introspected
// schema by validate:lane-topology, and read by every rule that needs it. The
// value still originates in the WRITER's own constant, so there remains exactly
// one definition of what gets stamped.
export const NOMINATOR_POSITIONS_SCAN_SOURCE = requireFullScanValue(
  "nominator_positions",
);

/**
 * Coverage, scoped to the full-scan producer.
 *
 * Every clause carries the source filter, including the `MAX(captured_at)` the
 * window is measured from -- scoping the count while leaving the anchor global
 * would compare the alpha scan's coverage against self-stake's clock and read
 * as zero coverage the moment the two producers' stamps diverged.
 *
 * `total` stays scoped too, so the number the alarm reports as context is the
 * same population the rule is judging rather than a second, larger one.
 */
export const NOMINATOR_POSITIONS_COVERAGE_SQL =
  "SELECT COUNT(DISTINCT coldkey) AS total, MAX(captured_at) AS latest, " +
  "COUNT(DISTINCT CASE WHEN captured_at >= " +
  "(SELECT MAX(captured_at) FROM nominator_positions WHERE source = ?) - ? " +
  "THEN coldkey END) " +
  "AS covered FROM nominator_positions WHERE source = ?";

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
interface NominatorPositionsCoverageRow {
  latest: NominatorPositions["captured_at"] | null;
  covered: string | number | null;
  total: string | number | null;
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
  env: NominatorPositionsStalenessWatchdogEnv | null | undefined,
  deps: NominatorPositionsStalenessDeps = {},
): Promise<Record<string, unknown>> {
  const now = deps.now ?? Date.now;
  const record = deps.recordException ?? recordExceptionEvent;
  // Whichever store holds the table (#10154). The verdict WRITE moved to
  // laneHealthStore already; this read did not, so the watchdog was measuring
  // the frozen copy D1 left and would have alarmed permanently -- reporting the lane
  // stalled while the lane was fine.
  const db = readStore(env, ["nominator_positions"]) as unknown as
    ReadStoreDb | undefined;
  if (!db?.first) return { ok: false, reason: "no store bound" };

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
    // Three binds, in statement order: the source anchoring the window's
    // MAX(captured_at), the window itself, then the source scoping the outer
    // aggregate. See NOMINATOR_POSITIONS_SCAN_SOURCE for why an unscoped read
    // reports a healthy self-stake run as a truncated alpha scan.
    const row = await db.first<NominatorPositionsCoverageRow>(
      NOMINATOR_POSITIONS_COVERAGE_SQL,
      [
        NOMINATOR_POSITIONS_SCAN_SOURCE,
        passWindowMs,
        NOMINATOR_POSITIONS_SCAN_SOURCE,
      ],
    );
    const verdict = evaluateNominatorPositionsStaleness({
      latestCapturedAtMs: numberOrNull(row?.latest),
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
      await record(env, {
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
    await recordLaneVerdict(laneHealthStore(env, deps.laneHealthDb), {
      lane: "nominator-positions-staleness",
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
