import { formatUptime } from "./health-serving.ts";
import { dailyLatencyColumns } from "./health-sql.ts";
import { DAY_MS, MAX_UPTIME_ROWS, UPTIME_WINDOW_DAYS } from "../workers/config.ts";
import { storeAll, type ObservationsReadDb } from "./analytics-store-read.ts";

export async function loadSubnetUptime(
  netuid: number,
  {
    window = "90d",
    observedAt = null,
    now = null,
    minSamples = null,
    db = null,
  }: {
    window?: string;
    observedAt?: unknown;
    now?: string | null;
    minSamples?: number | null;
    db?: ObservationsReadDb | null;
  } = {},
): Promise<unknown> {
  const windowParam = Object.hasOwn(UPTIME_WINDOW_DAYS, window)
    ? window
    : "90d";
  // Optional min_samples floor: drop low-sample day rows (daily probe count
  // below the threshold, incl. zero-sample "unknown" days) via HAVING,
  // mirroring the REST /uptime route (#2700). Null → no filter.
  const sampleFloor =
    Number.isInteger(minSamples) && (minSamples as number) >= 0
      ? minSamples
      : null;
  const days = UPTIME_WINDOW_DAYS[windowParam] as number;
  const cutoff = new Date(Date.now() - days * DAY_MS)
    .toISOString()
    .slice(0, 10);
  const rows = await storeAll(
    db,
    `SELECT MAX(surface_id) AS surface_id,
            COALESCE(surface_key, surface_id) AS surface_key,
            day,
            SUM(samples) AS samples,
            SUM(ok_count) AS ok_count,
            CASE
              WHEN SUM(samples) > 0 THEN ROUND(CAST(CAST(SUM(ok_count) AS REAL) / SUM(samples) AS NUMERIC), 4)
              ELSE NULL
            END AS uptime_ratio,
            ${dailyLatencyColumns({ roundedAvg: true })},
            MAX(p50_latency_ms) AS p50,
            MAX(p95_latency_ms) AS p95,
            MAX(p99_latency_ms) AS p99,
            CASE
              WHEN SUM(samples) = 0 THEN 'unknown'
              WHEN SUM(ok_count) = SUM(samples) THEN 'ok'
              WHEN SUM(ok_count) = 0 THEN 'failed'
              ELSE 'degraded'
            END AS status
     FROM surface_uptime_daily
     WHERE netuid = ? AND day >= ?
     GROUP BY COALESCE(surface_key, surface_id), day
     ${sampleFloor !== null ? "HAVING SUM(samples) >= ?\n     " : ""}ORDER BY day DESC
     LIMIT ?`,
    sampleFloor !== null
      ? [netuid, cutoff, sampleFloor, MAX_UPTIME_ROWS]
      : [netuid, cutoff, MAX_UPTIME_ROWS],
  );
  // formatUptime (health-serving.ts, not yet converted) infers its
  // observedAt/now default-param types as exactly `null` from their `= null`
  // defaults -- the untyped-default-parameter inference gap.
  return formatUptime({
    netuid,
    window: windowParam,
    observedAt,
    rows,
    now: now || new Date().toISOString(),
  });
}

