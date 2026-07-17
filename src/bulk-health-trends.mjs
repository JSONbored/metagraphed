// Shared all-subnet bulk health trends loader for REST + MCP parity.
//
// D1 fully eliminated (2026-07-17): surface_uptime_daily is Postgres-only now
// (both callers try the Postgres tier first) -- this loader is only reached
// on a tier miss, so it always returns the schema-stable empty shape.

import { HEALTH_TREND_WINDOWS } from "../workers/config.mjs";
import { formatBulkTrends } from "./health-serving.mjs";

export async function loadBulkHealthTrends({ observedAt = null } = {}) {
  const windows = {};
  for (const label of Object.keys(HEALTH_TREND_WINDOWS)) {
    windows[label] = [];
  }
  const data = formatBulkTrends({
    observedAt,
    windows,
    windowDays: HEALTH_TREND_WINDOWS,
  });
  return { data, rows: [] };
}
