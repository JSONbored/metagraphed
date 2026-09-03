// Watch the daily alpha scan using its own delivery receipts (#11997).
// Self-stake legitimately replaces positions on the same key, so neither the
// current row source nor its timestamp can prove a full scan's coverage.
import { laneHealthStore } from "./lane-health-store.ts";
import { laneVerdictDetail } from "./lane-verdict-detail.ts";
import { missedTicksMs } from "./producer-cadence.ts";
import { FLUSH_INTERVAL_MS } from "./neon-write-buffer.ts";
import { recordExceptionEvent } from "./usage-telemetry.ts";
import { recordLaneVerdict, type LaneHealthDb } from "./lane-health.ts";
import { countOrZero, numberOrNull, readStore } from "./read-store.ts";
import type { NominatorScanReceipts } from "../generated/db/types.ts";
import type { StoreEnv } from "./read-store.ts";
import type { TelemetryEnv } from "./usage-telemetry.ts";
import {
  NOMINATOR_HISTORY_MS,
  NOMINATOR_POSITIONS_COVERAGE_SQL,
  nominatorCoverageFloor,
} from "./nominator-scan-coverage.ts";

export {
  NOMINATOR_POSITIONS_EXPECTED_COLDKEYS,
  NOMINATOR_POSITIONS_COVERAGE_FLOOR_RATIO,
  NOMINATOR_POSITIONS_COVERAGE_FLOOR_COLDKEYS,
  NOMINATOR_POSITIONS_COVERAGE_SQL,
} from "./nominator-scan-coverage.ts";

type NominatorPositionsStalenessWatchdogEnv = StoreEnv &
  TelemetryEnv & {
    NOMINATOR_POSITIONS_COVERAGE_FLOOR_COLDKEYS?: unknown;
    NOMINATOR_POSITIONS_STALENESS_THRESHOLD_MS?: unknown;
  };

// The producer is daily. Preserve the 36h bound covering its observed 34.57h
// worst pass gap; receipt provenance changes neither cadence nor this limit.
export const NOMINATOR_POSITIONS_STALENESS_THRESHOLD_MS = missedTicksMs(
  "validator_nominators",
  1.5,
);
// A scan may wait the buffer's ten-minute interval before draining. Allow one
// further interval to finish that drain, while remaining unknown rather than
// healthy. This is below the watchdog's 30-minute cadence; missing rows after
// this bound still alert, and the 36-hour freshness limit is unchanged.
export const NOMINATOR_POSITIONS_DELIVERY_GRACE_MS = 2 * FLUSH_INTERVAL_MS;

export type NominatorPositionsStalenessReason =
  "no_rows" | "stale" | "partial" | "in_progress" | null;

export interface NominatorPositionsStalenessVerdict {
  stale: boolean;
  reason: NominatorPositionsStalenessReason;
  age_ms: number | null;
  latest_captured_at: number | null;
  threshold_ms: number;
  covered_coldkeys: number;
  /** Distinct coldkeys in retained scan receipts, for diagnostic context. */
  total_coldkeys: number;
  coverage_floor_coldkeys: number;
  received_rows: number;
  expected_rows: number | null;
  delivery_complete: boolean;
}

/** Evaluate delivery, age and width separately; fresh is not proof of complete. */
export function evaluateNominatorPositionsStaleness(input: {
  latestCapturedAtMs: number | null;
  coveredColdkeys: number;
  totalColdkeys: number;
  receivedRows: number;
  expectedRows: number | null;
  completedAtMs: number | null;
  nowMs: number;
  thresholdMs: number;
  coverageFloorColdkeys: number;
}): NominatorPositionsStalenessVerdict {
  const {
    latestCapturedAtMs,
    coveredColdkeys,
    totalColdkeys,
    receivedRows,
    expectedRows,
    completedAtMs,
    nowMs,
    thresholdMs,
    coverageFloorColdkeys,
  } = input;
  const deliveryComplete =
    expectedRows !== null &&
    expectedRows > 0 &&
    receivedRows === expectedRows &&
    completedAtMs !== null;
  const base = {
    latest_captured_at: latestCapturedAtMs,
    threshold_ms: thresholdMs,
    covered_coldkeys: coveredColdkeys,
    total_coldkeys: totalColdkeys,
    coverage_floor_coldkeys: coverageFloorColdkeys,
    received_rows: receivedRows,
    expected_rows: expectedRows,
    delivery_complete: deliveryComplete,
  };
  if (latestCapturedAtMs === null) {
    return { ...base, stale: true, reason: "no_rows", age_ms: null };
  }
  const age = nowMs - latestCapturedAtMs;
  if (age > thresholdMs) {
    return { ...base, stale: true, reason: "stale", age_ms: age };
  }
  if (!deliveryComplete) {
    if (
      age >= 0 &&
      age <= NOMINATOR_POSITIONS_DELIVERY_GRACE_MS &&
      (expectedRows === null || receivedRows <= expectedRows)
    ) {
      return { ...base, stale: false, reason: "in_progress", age_ms: age };
    }
    return { ...base, stale: true, reason: "partial", age_ms: age };
  }
  if (coveredColdkeys < coverageFloorColdkeys) {
    return { ...base, stale: true, reason: "partial", age_ms: age };
  }
  return { ...base, stale: false, reason: null, age_ms: age };
}

interface NominatorPositionsCoverageRow {
  latest: NominatorScanReceipts["captured_at"] | null;
  covered: string | number | null;
  total: string | number | null;
  received_rows: string | number | null;
  expected_rows: string | number | null;
  completed_at: NominatorScanReceipts["captured_at"] | null;
  baseline_days: string | number | null;
  baseline_coldkeys: string | number | null;
}

export interface NominatorPositionsStalenessDeps {
  laneHealthDb?: LaneHealthDb | null;
  now?: () => number;
  recordException?: typeof recordExceptionEvent;
}

/** One tick. A failed query remains a failed measurement, never a healthy lane. */
export async function runNominatorPositionsStalenessWatchdog(
  env: NominatorPositionsStalenessWatchdogEnv | null | undefined,
  deps: NominatorPositionsStalenessDeps = {},
): Promise<Record<string, unknown>> {
  const now = deps.now ?? Date.now;
  const record = deps.recordException ?? recordExceptionEvent;
  const db = readStore(env, [
    "nominator_scan_receipts",
    "nominator_positions_passes",
  ]);
  if (!db?.first) return { ok: false, reason: "no store bound" };
  const thresholdMs =
    Number(env?.NOMINATOR_POSITIONS_STALENESS_THRESHOLD_MS) ||
    NOMINATOR_POSITIONS_STALENESS_THRESHOLD_MS;
  const checkedAt = now();
  try {
    const row = await db.first<NominatorPositionsCoverageRow>(
      NOMINATOR_POSITIONS_COVERAGE_SQL,
      [checkedAt - NOMINATOR_HISTORY_MS],
    );
    const baselineDays = countOrZero(row?.baseline_days);
    const baselineColdkeys = numberOrNull(row?.baseline_coldkeys);
    const floor = nominatorCoverageFloor(
      baselineDays,
      baselineColdkeys,
      env?.NOMINATOR_POSITIONS_COVERAGE_FLOOR_COLDKEYS,
    );
    const verdict = evaluateNominatorPositionsStaleness({
      latestCapturedAtMs: numberOrNull(row?.latest),
      coveredColdkeys: countOrZero(row?.covered),
      totalColdkeys: countOrZero(row?.total),
      receivedRows: countOrZero(row?.received_rows),
      expectedRows: numberOrNull(row?.expected_rows),
      completedAtMs: numberOrNull(row?.completed_at),
      nowMs: checkedAt,
      thresholdMs,
      coverageFloorColdkeys: floor.coldkeys,
    });
    if (verdict.stale) {
      const age =
        verdict.age_ms === null
          ? "no rows at all"
          : `${(verdict.age_ms / 3_600_000).toFixed(1)} h old`;
      const message =
        verdict.reason === "partial"
          ? `nominator-positions lane truncated: the newest pass covered only ${verdict.covered_coldkeys} of ${verdict.total_coldkeys} coldkeys against a floor of ${verdict.coverage_floor_coldkeys}; delivered ${verdict.received_rows}/${verdict.expected_rows ?? "unknown"} rows (newest stamp ${age}) -- the capture is RECENT and PARTIAL`
          : `nominator-positions lane stalled: latest snapshot is ${age} (threshold ${thresholdMs / 3_600_000} h) -- /accounts/{ss58}/positions is answering from a ledger nothing is refreshing`;
      await record(env, {
        error: new Error(message),
        route: "watchdog:nominator-positions-staleness",
        errorCode: "stale_lane",
      }).catch(() => false);
    }
    await recordLaneVerdict(laneHealthStore(env, deps.laneHealthDb), {
      lane: "nominator-positions-staleness",
      verdict:
        verdict.reason === "in_progress"
          ? "unknown"
          : verdict.stale
            ? "stale"
            : "ok",
      age_ms: verdict.age_ms,
      detail: laneVerdictDetail(verdict.reason, {
        covered: verdict.covered_coldkeys,
        total: verdict.total_coldkeys,
        floor: verdict.coverage_floor_coldkeys,
        received: verdict.received_rows,
        expected: verdict.expected_rows,
      }),
      checked_at: checkedAt,
    });
    return {
      ok: true,
      alerted: verdict.stale,
      ...verdict,
      coverage_floor_source: floor.source,
      baseline_days: baselineDays,
      baseline_coldkeys: baselineColdkeys,
    };
  } catch (err) {
    return {
      ok: false,
      reason: "query_failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
