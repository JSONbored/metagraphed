// Shared all-subnet bulk health trends D1 loader for REST + MCP parity.
// Pure orchestration over surface_uptime_daily rows + formatBulkTrends; REST
// handlers keep edge-cache + envelope wiring.

import {
  DAY_MS,
  HEALTH_TREND_WINDOWS,
  MAX_BULK_TREND_ROWS,
} from "../workers/config.mjs";
import { formatBulkTrends } from "./health-serving.mjs";
import { dailyLatencyColumns } from "./health-sql.mjs";

// Compact all-subnet 7d/30d daily uptime + latency trend matrix (#1164).
// `d1` is a (sql, params) => rows runner — d1Runner(env) in the Worker,
// mcpD1Runner(ctx) in the MCP server.
export async function loadBulkHealthTrends(
  d1,
  { observedAt = null, now = Date.now() } = {},
) {
  const maxWindowDays = Math.max(...Object.values(HEALTH_TREND_WINDOWS));
  const cutoffDay = new Date(now - maxWindowDays * DAY_MS)
    .toISOString()
    .slice(0, 10);
  const rows = await d1(
    `SELECT netuid,
            day AS date,
            SUM(samples) AS total,
            SUM(ok_count) AS ok_count,
            ${dailyLatencyColumns()}
     FROM surface_uptime_daily
     WHERE day >= ?
     GROUP BY netuid, day
     ORDER BY netuid, day
     LIMIT ?`,
    [cutoffDay, MAX_BULK_TREND_ROWS],
  );
  const windows = {};
  for (const [label, days] of Object.entries(HEALTH_TREND_WINDOWS)) {
    const windowCutoff = new Date(now - days * DAY_MS)
      .toISOString()
      .slice(0, 10);
    windows[label] = rows.filter(
      (row) => String(row.day || row.date) >= windowCutoff,
    );
  }
  const data = formatBulkTrends({
    observedAt,
    windows,
    windowDays: HEALTH_TREND_WINDOWS,
  });
  return { data, rows };
}
