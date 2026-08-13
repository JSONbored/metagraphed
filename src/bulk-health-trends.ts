// Shared all-subnet bulk health trends loader for REST + MCP + GraphQL parity.
//
// store reads resurrected (2026-08-03, box decommission) -- the same move
// loadSubnetUptime / loadSubnetHealthTrends made on 2026-08-02, which this
// loader was left out of. `surface_uptime_daily` is written to D1 by the
// health-uptime-rollup lane and holds a full rolling window there (verified
// live: 12,028 rows across 124 netuids, current through today), so the
// Postgres-tier miss that follows the box's retirement no longer has to mean
// an empty payload. Without a `db` binding this still returns the
// schema-stable empty shape that has been the floor since 2026-07-17.
//
// The query is the pre-elimination Postgres one, translated: `day` is already
// TEXT in D1 so the `::text` cast is gone, and `::float8` becomes
// `CAST(... AS REAL)`. Latency is weighted by the count of HEALTHY readings
// behind each day's mean (`latency_samples`), not by total samples --
// averaging the daily means unweighted would let a 2-sample day pull the
// window as hard as a 300-sample one.

import {
  HEALTH_TREND_WINDOWS,
  MAX_BULK_TREND_ROWS,
} from "../workers/config.ts";
import { storeAll, type ObservationsReadDb } from "./analytics-live.ts";
import { formatBulkTrends, utcWindowCutoffDay } from "./health-serving.ts";

/** Sum of healthy readings behind the day's mean, 0 when the day has no mean. */
const LATENCY_WEIGHT =
  "SUM(CASE WHEN avg_latency_ms IS NOT NULL THEN COALESCE(latency_samples, samples) ELSE 0 END)";

export async function loadBulkHealthTrends({
  observedAt = null,
  db = null,
  window = null,
  limit = null,
  offset = 0,
}: {
  observedAt?: string | null;
  db?: ObservationsReadDb | null;
  /**
   * One window label, or null for every window (#9981).
   *
   * This narrows the D1 SCAN as well as the response: an unfiltered request
   * reads the widest window because it has to answer for all of them, but a
   * 7d-only request has no reason to read 30 days of rows to throw 23 away.
   */
  window?: string | null;
  /** Subnets per window; null means every subnet, the historical behaviour. */
  limit?: number | null;
  offset?: number;
} = {}): Promise<{
  data: Record<string, unknown>;
  rows: unknown[];
}> {
  const now = Date.now();
  // One read over the widest window REQUESTED, then filtered per window in
  // memory. The windows are nested (7d is a suffix of 30d), so N reads would
  // be N scans of overlapping data for the same answer.
  const requested =
    window !== null && Object.hasOwn(HEALTH_TREND_WINDOWS, window)
      ? { [window]: HEALTH_TREND_WINDOWS[window]! }
      : HEALTH_TREND_WINDOWS;
  const maxWindowDays = Math.max(...Object.values(requested));
  const cutoffDay = utcWindowCutoffDay(now, maxWindowDays);

  const rows = await storeAll(
    db,
    `SELECT netuid,
            day AS date,
            SUM(samples) AS total,
            SUM(ok_count) AS ok_count,
            ${LATENCY_WEIGHT} AS latency_samples,
            CASE
              WHEN ${LATENCY_WEIGHT} > 0
                THEN CAST(SUM(CASE WHEN avg_latency_ms IS NOT NULL
                                   THEN avg_latency_ms * COALESCE(latency_samples, samples)
                                   ELSE 0 END) AS REAL) / ${LATENCY_WEIGHT}
              ELSE NULL
            END AS avg_latency_ms
     FROM surface_uptime_daily
     WHERE day >= ?
     GROUP BY netuid, day
     ORDER BY netuid, day
     LIMIT ?`,
    [cutoffDay, MAX_BULK_TREND_ROWS],
  );

  const windows: Record<string, unknown[]> = {};
  for (const [label, days] of Object.entries(requested)) {
    const windowCutoff = utcWindowCutoffDay(now, days);
    windows[label] = rows.filter((row) => String(row.date) >= windowCutoff);
  }

  const data = formatBulkTrends({
    observedAt,
    windows,
    windowDays: requested,
    limit,
    offset,
  });
  return { data, rows };
}
