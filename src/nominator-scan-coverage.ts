// Full-scan proof comes from immutable receipts, never the mutable position
// source or an additive delivery counter (#11997, #11390).
export const NOMINATOR_POSITIONS_EXPECTED_COLDKEYS = 21_263;
const NOMINATOR_POSITIONS_COVERAGE_FLOOR_RATIO = 0.8;
/** Bootstrap floor: 17,010 coldkeys, until seven completed days establish history. */
export const NOMINATOR_POSITIONS_COVERAGE_FLOOR_COLDKEYS = Math.round(
  NOMINATOR_POSITIONS_EXPECTED_COLDKEYS *
    NOMINATOR_POSITIONS_COVERAGE_FLOOR_RATIO,
);
export const NOMINATOR_BASELINE_DAYS = 7;
export const NOMINATOR_HISTORY_MS = 30 * 24 * 60 * 60_000;

// One completed scan per prior UTC day, so deployments/replays cannot give a
// single day seven votes. Exclude the newest day's scans from its own baseline.
// A pass counter can be inflated by queue replay: only exact receipt row counts
// prove delivery. Completed-but-small scans remain visible to the width rule.
export const NOMINATOR_POSITIONS_COVERAGE_SQL = `
WITH recent_receipts AS (
  SELECT captured_at, coldkey, row_count
  FROM nominator_scan_receipts WHERE captured_at >= ?
), scans AS (
  SELECT captured_at, COUNT(*) AS covered, SUM(row_count) AS received
  FROM recent_receipts GROUP BY captured_at
), latest AS (
  SELECT GREATEST(
    (SELECT MAX(captured_at) FROM scans),
    (SELECT MAX(captured_at) FROM nominator_positions_passes)
  ) AS captured_at
), history AS (
  SELECT DISTINCT ON (s.captured_at / 86400000)
    s.captured_at / 86400000 AS day, s.covered
  FROM scans s
  JOIN nominator_positions_passes p USING (captured_at)
  CROSS JOIN latest l
  WHERE s.captured_at / 86400000 < l.captured_at / 86400000
    AND p.expected_rows > 0 AND p.completed_at IS NOT NULL
    AND s.received = p.expected_rows
  ORDER BY s.captured_at / 86400000 DESC, s.captured_at DESC
  LIMIT ${NOMINATOR_BASELINE_DAYS}
), baseline AS (
  SELECT COUNT(*) AS days,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY covered) AS coldkeys
  FROM history
)
SELECT l.captured_at AS latest, COALESCE(s.covered, 0) AS covered,
  (SELECT COUNT(DISTINCT coldkey) FROM recent_receipts) AS total,
  COALESCE(s.received, 0) AS received_rows,
  p.expected_rows, p.completed_at,
  b.days AS baseline_days, b.coldkeys AS baseline_coldkeys
FROM latest l
LEFT JOIN scans s ON s.captured_at = l.captured_at
LEFT JOIN nominator_positions_passes p ON p.captured_at = l.captured_at
CROSS JOIN baseline b`;

export function nominatorCoverageFloor(
  baselineDays: number,
  baselineColdkeys: number | null,
  override: unknown,
): { coldkeys: number; source: "override" | "history" | "bootstrap" } {
  const explicit = Number(override);
  if (Number.isFinite(explicit) && explicit >= 1) {
    return { coldkeys: Math.round(explicit), source: "override" };
  }
  if (
    baselineDays >= NOMINATOR_BASELINE_DAYS &&
    baselineColdkeys !== null &&
    Number.isFinite(baselineColdkeys) &&
    baselineColdkeys > 0
  ) {
    return {
      coldkeys: Math.round(
        baselineColdkeys * NOMINATOR_POSITIONS_COVERAGE_FLOOR_RATIO,
      ),
      source: "history",
    };
  }
  // A short or failed history read cannot silently lower the existing floor.
  return {
    coldkeys: NOMINATOR_POSITIONS_COVERAGE_FLOOR_COLDKEYS,
    source: "bootstrap",
  };
}
