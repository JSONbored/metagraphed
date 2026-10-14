/** Fixed failure vocabulary. Never pass exception text, rows or credentials to
 * the diagnostic sink. A capacity label requires an actual SQLite FULL error. */
export const LANE_HEALTH_WRITE_FAILURES = [
  "missing_secret",
  "missing_store",
  "insert_capacity",
  "insert_busy",
  "insert_timeout",
  "insert_constraint",
  "insert_schema",
  "insert_error",
  "returned_count",
  "returned_identity",
] as const;
export type LaneHealthWriteFailure =
  (typeof LANE_HEALTH_WRITE_FAILURES)[number];

export function classifyLaneHealthWriteError(
  error: unknown,
): LaneHealthWriteFailure {
  // Drivers may wrap their SQLite error. Inspect at most three bounded
  // messages/codes; no part of either is returned or logged.
  try {
    for (let depth = 0; error && depth < 3; depth++) {
      if (typeof error !== "object") break;
      const value = error as { code?: unknown; message?: unknown; cause?: unknown };
      const text = [value.code, value.message]
        .filter((part): part is string => typeof part === "string")
        .map((part) => part.slice(0, 2048))
        .join(" ");
      if (/\bSQLITE_FULL\b|\bdatabase or disk is full\b/i.test(text))
        return "insert_capacity";
      if (/\bSQLITE_BUSY\b|\bSQLITE_LOCKED\b/i.test(text))
        return "insert_busy";
      if (/\btimeout\b|\btimed out\b/i.test(text)) return "insert_timeout";
      if (/\bSQLITE_CONSTRAINT\b|\bconstraint failed\b/i.test(text))
        return "insert_constraint";
      if (/\bno such table\b/i.test(text)) return "insert_schema";
      error = value.cause;
    }
  } catch {
    // Exotic error getters must not break the best-effort diagnostic path.
  }
  return "insert_error";
}

/** One fixed event at most per minute per isolate, across all lanes/reasons.
 * The route has already bounded its census to 50. No per-lane/hash map grows. */
export function createLaneHealthWriteReporter(
  now: () => number = Date.now,
  emit: (summary: {
    expected: number | null;
    confirmed: number;
    failures: Record<LaneHealthWriteFailure, number>;
  }) => void = (summary) =>
    console.warn("poller_lane_health_write_failure", summary),
) {
  let nextReportAt = 0;
  return (
    expected: number | null,
    confirmed: number,
    failures: readonly LaneHealthWriteFailure[],
  ): void => {
    if (!failures.length) return;
    const time = now();
    if (time < nextReportAt) return;
    nextReportAt = time + 60_000;
    try {
      emit({
        expected,
        confirmed,
        failures: Object.fromEntries(
          LANE_HEALTH_WRITE_FAILURES.map((reason) => [
            reason,
            failures.filter((failure) => failure === reason).length,
          ]),
        ) as Record<LaneHealthWriteFailure, number>,
      });
    } catch {
      // Reporting cannot change the persistence result or HTTP outcome.
    }
  };
}
