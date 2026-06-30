// Network-wide economics trends D1 loader for REST + MCP parity (#1307).
// Pure orchestration over subnet_snapshots rows + buildEconomicsTrends; REST
// handlers keep edge-cache + envelope wiring.

import { DAY_MS } from "../workers/config.mjs";
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

export async function loadEconomicsTrends(
  d1,
  { windowLabel, windowDays = null, now = Date.now() } = {},
) {
  const params = [];
  let sql =
    "SELECT snapshot_date, total_stake_tao, alpha_price_tao, " +
    "validator_count, miner_count, emission_share " +
    "FROM subnet_snapshots WHERE TRUE";
  if (windowDays != null) {
    const cutoff = new Date(now - windowDays * DAY_MS)
      .toISOString()
      .slice(0, 10);
    sql += " AND snapshot_date >= ?";
    params.push(cutoff);
  }
  sql += " ORDER BY snapshot_date DESC LIMIT ?";
  params.push(ECONOMICS_TRENDS_ROW_CAP);
  const rows = await d1(sql, params);
  const data = buildEconomicsTrends(rows, { window: windowLabel });
  return { data, rows };
}
