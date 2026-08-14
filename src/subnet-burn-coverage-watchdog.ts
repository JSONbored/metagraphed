// The coverage alarm for the registration-cost series (#10308).
//
// ## The gap this closes, measured
//
// `subnet_burn_history` wrote ONE row per 15-minute tick instead of 129, for 34
// hours, and every existing check said fine:
//
//   - `table-freshness` measures `MAX(observed_at)`, and three of 129 netuids
//     kept writing, so the table read 0.09h fresh throughout. That module's own
//     header says freshness is "did anything arrive" and that coverage belongs
//     to the per-lane watchdogs -- correct, and this table had no per-lane
//     watchdog at all.
//   - `lane_health` said `captured 129, pruned` on every broken pass, because
//     the lane counted rows READ from the chain rather than rows WRITTEN
//     (#10304 fixed that half).
//
// So two independent detectors existed and neither measured coverage. This is
// the one that would have fired on the first tick: 3 of 129 is not a threshold
// question.
//
// ## The floor is DERIVED, not declared
//
// The expected netuid set is whatever `subnet_hyperparams` currently holds --
// the same live subnet population the burn capture walks. A constant here
// would rot the moment a subnet registers or is pruned, and the dangerous
// direction (a floor quietly below the real count) is invisible.
//
// This is the same reasoning src/hotkey-alpha-staleness-watchdog.ts uses for
// its own floor, and it matters more here than it looks: subnet count is not
// stable. The network sits AT `SubnetLimit`, so every new registration evicts
// one (#10285), and a hand-set 129 would be wrong on the first churn.
//
// ## Why it keys on the NEWEST TICK, not a window
//
// Every row of one pass shares a single `observed_at` -- the writer stamps the
// tick once and binds it to all 129 rows, so a cross-subnet comparison is
// meaningful rather than smeared. That makes "how many netuids does the newest
// stamp carry" an exact question with no window to tune, and it is precisely
// the number that went from 129 to 1.
//
// AN EMPTY POPULATION SKIPS THE CLAUSE rather than dividing by nothing. A floor
// of zero marks every pass complete, including no pass at all -- and
// `subnet_hyperparams` has its own staleness lane, so restating its verdict
// here would put two lanes' names on one fault.
import { laneHealthStore } from "./lane-health-store.ts";
import { recordLaneVerdict, type LaneHealthDb } from "./lane-health.ts";
import { readStore } from "./read-store.ts";
import type { SubnetBurnHistory } from "../generated/db/types.ts";

export const SUBNET_BURN_COVERAGE_LANE = "subnet-burn-coverage";

/** Tables the rule reads. Both, or the read declines -- readStore is
 * all-or-nothing, and a half-declared pair reads as silence. */
export const SUBNET_BURN_COVERAGE_TABLES = [
  "subnet_burn_history",
  "subnet_hyperparams",
] as const;

/**
 * How much of the live subnet set one tick must carry.
 *
 * NINETY-FIVE PERCENT, tighter than the 80% its hotkey-alpha cousin uses,
 * because this producer has no churn to absorb: every row in a tick comes from
 * ONE `state_queryStorageAt` read of every netuid at one block, so a complete
 * pass writes the whole set by construction. The 5% is for the genuine race --
 * a subnet registered between the burn read and this check -- and nothing else.
 *
 * The failure it is sized against wrote 2.3% of the set, so the exact ratio is
 * not load-bearing; anything under "almost all" catches it.
 */
export const SUBNET_BURN_COVERAGE_FLOOR_RATIO = 0.95;

/**
 * One read answering three questions: which tick is newest, how many netuids it
 * carries, and how many the live subnet set has.
 *
 * `covered` counts DISTINCT netuids at the newest stamp rather than rows: a
 * writer that wrote one netuid 129 times would otherwise pass a row count, and
 * that is close enough to the observed failure to be worth excluding.
 */
// BOTH SIDES ARE ONE PASS (#11185). `expected` counted DISTINCT netuid over the
// WHOLE of subnet_hyperparams while `covered` counted one stamp, which is the
// asymmetry that made hotkey-alpha alarm on a complete pass for hours (#11170):
// there, `referenced` spanned all of nominator_positions' history and no correct
// pass could ever reach the floor.
//
// It has not fired here yet, and only because nothing has been removed.
// Measured 2026-08-14: subnet_hyperparams holds 129 distinct netuids in total
// AND 129 at its newest stamp -- identical, because no netuid has ever left.
// Chain agrees: TotalNetworks = 129 and NetworksAdded = 129 entries, which is
// 128 subnets plus root (netuid 0), max netuid 128.
//
// The first deregistration that leaves a stale row behind breaks that
// coincidence: the denominator would exceed the live set and this alarm would
// fire forever on complete passes. Windowing it to that table's own newest pass
// makes the comparison structural rather than lucky.
export const SUBNET_BURN_COVERAGE_SQL =
  "SELECT (SELECT MAX(observed_at) FROM subnet_burn_history) AS latest," +
  " (SELECT COUNT(DISTINCT netuid) FROM subnet_burn_history" +
  " WHERE observed_at = (SELECT MAX(observed_at) FROM subnet_burn_history))" +
  " AS covered," +
  " (SELECT COUNT(DISTINCT netuid) FROM subnet_hyperparams" +
  " WHERE captured_at = (SELECT MAX(captured_at) FROM subnet_hyperparams))" +
  " AS expected";

/**
 * The single row that query returns.
 *
 * `latest` is `subnet_burn_history.observed_at`, typed through the generated
 * interface so a column that changes type in Neon changes here. The two counts
 * are NOT: COUNT() returns BIGINT, which the driver hands back as a string
 * whenever the value is not exactly representable, and the column's own type
 * would understate that. Every member is nullable because each subselect
 * answers NULL over an empty table -- which is exactly the state this watchdog
 * exists to notice.
 */
interface SubnetBurnCoverageRow {
  latest: SubnetBurnHistory["observed_at"] | null;
  covered: string | number | null;
  expected: string | number | null;
}

export type SubnetBurnCoverageReason = "no_rows" | "stale" | "partial" | null;

export interface SubnetBurnCoverageVerdict {
  stale: boolean;
  reason: SubnetBurnCoverageReason;
  age_ms: number | null;
  latest_observed_at: number | null;
  threshold_ms: number;
  /** Distinct netuids the NEWEST tick carries. The coverage signal itself. */
  covered_netuids: number;
  /** Distinct netuids the live subnet set holds right now. */
  expected_netuids: number;
  /** The derived floor, or null when there is nothing to derive it from. */
  coverage_floor_netuids: number | null;
}

/**
 * How old the newest tick may get before this is a stall.
 *
 * ONE HOUR, four ticks of the producer's 15-minute cadence. Sized from the
 * cadence rather than picked: a bound at one interval alarms on ordinary
 * jitter, and one at ten never alarms at all (#9301). Four absorbs a redeploy
 * and a slow pass while still catching a dead lane within the hour.
 */
export const SUBNET_BURN_COVERAGE_THRESHOLD_MS = 60 * 60 * 1000;

/** The rule alone, testable without a database or a clock. */
export function evaluateSubnetBurnCoverage(input: {
  latestObservedAtMs: number | null;
  coveredNetuids: number;
  expectedNetuids: number;
  nowMs: number;
  thresholdMs: number;
  coverageFloorRatio: number;
}): SubnetBurnCoverageVerdict {
  const {
    latestObservedAtMs,
    coveredNetuids,
    expectedNetuids,
    nowMs,
    thresholdMs,
    coverageFloorRatio,
  } = input;
  // Null rather than 0 when the subnet set is unreadable: "we did not measure a
  // floor" and "the floor is zero" reach opposite conclusions about the same
  // tick, and only the first is true.
  const coverageFloorNetuids =
    expectedNetuids > 0
      ? Math.round(expectedNetuids * coverageFloorRatio)
      : null;
  const base = {
    latest_observed_at: latestObservedAtMs,
    threshold_ms: thresholdMs,
    covered_netuids: coveredNetuids,
    expected_netuids: expectedNetuids,
    coverage_floor_netuids: coverageFloorNetuids,
  };
  if (latestObservedAtMs === null) {
    return { ...base, stale: true, reason: "no_rows", age_ms: null };
  }
  const age = nowMs - latestObservedAtMs;
  if (age > thresholdMs) {
    // Checked BEFORE coverage: if nothing has run in an hour, the coverage
    // number describes an old tick and the headline is that the producer
    // stopped, not how much its last attempt wrote.
    return { ...base, stale: true, reason: "stale", age_ms: age };
  }
  if (coverageFloorNetuids !== null && coveredNetuids < coverageFloorNetuids) {
    // Recent AND short -- the discrimination this rule exists for, and the
    // exact state that read as healthy for 34 hours.
    return { ...base, stale: true, reason: "partial", age_ms: age };
  }
  return { ...base, stale: false, reason: null, age_ms: age };
}

export interface SubnetBurnCoverageDeps {
  now?: () => number;
  recordVerdict?: typeof recordLaneVerdict;
}

/**
 * Read, judge, record. Never throws: a watchdog that can take down the cron it
 * rides on is worse than one that misses a tick.
 */
export async function runSubnetBurnCoverageWatchdog(
  env: Env,
  deps: SubnetBurnCoverageDeps = {},
): Promise<SubnetBurnCoverageVerdict | null> {
  const now = deps.now ?? Date.now;
  const record = deps.recordVerdict ?? recordLaneVerdict;
  const db = readStore(env, SUBNET_BURN_COVERAGE_TABLES as unknown as string[]);
  if (!db) return null;
  let row: SubnetBurnCoverageRow | undefined;
  try {
    const rows = await db.query<SubnetBurnCoverageRow>(
      SUBNET_BURN_COVERAGE_SQL,
    );
    row = rows[0];
  } catch {
    // An unreadable store is not a verdict about the producer.
    return null;
  }
  if (!row) return null;
  const verdict = evaluateSubnetBurnCoverage({
    latestObservedAtMs: numberOrNull(row.latest),
    coveredNetuids: numberOrNull(row.covered) ?? 0,
    expectedNetuids: numberOrNull(row.expected) ?? 0,
    nowMs: now(),
    thresholdMs: SUBNET_BURN_COVERAGE_THRESHOLD_MS,
    coverageFloorRatio: SUBNET_BURN_COVERAGE_FLOOR_RATIO,
  });
  await record(laneHealthStore(env) as unknown as LaneHealthDb, {
    lane: SUBNET_BURN_COVERAGE_LANE,
    verdict: verdict.stale ? "stale" : "ok",
    age_ms: verdict.age_ms,
    // The numbers, not just the word: "3 of 129 netuids" is the whole finding,
    // and an operator reading `stale` alone would go looking for a dead lane
    // rather than a partial one.
    detail:
      `${verdict.covered_netuids} of ${verdict.expected_netuids} netuids` +
      (verdict.reason ? ` (${verdict.reason})` : ""),
    checked_at: now(),
  });
  return verdict;
}

function numberOrNull(value: unknown): number | null {
  const n = typeof value === "bigint" ? Number(value) : Number(value);
  return Number.isFinite(n) ? n : null;
}
