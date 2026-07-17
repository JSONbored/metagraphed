// Network-wide economics trends loader for REST + MCP parity (#1307).
//
// D1 fully eliminated (2026-07-17): subnet_snapshots is Postgres-only now
// (every caller tries the Postgres tier first) -- this is only reached on a
// tier miss, so it always returns the schema-stable empty shape.

import {
  buildEconomicsTrends,
  DEFAULT_HISTORY_WINDOW,
  parseHistoryWindow,
} from "./neuron-history.mjs";

// ~129 subnets × 365 days ≈ 47k rows for `all`; generous but finite.
export const ECONOMICS_TRENDS_ROW_CAP = 60000;

export function parseEconomicsTrendsWindow(window) {
  const parsed = parseHistoryWindow(
    window === undefined || window === null ? DEFAULT_HISTORY_WINDOW : window,
  );
  if (parsed.error) return null;
  return parsed;
}

export async function loadEconomicsTrends({ windowLabel } = {}) {
  const data = buildEconomicsTrends([], { window: windowLabel, capped: false });
  return { data, rows: [] };
}
