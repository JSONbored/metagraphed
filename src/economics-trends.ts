// Network-wide economics trends loader for REST + MCP parity (#1307).
//
// D1 reads resurrected (2026-08-02, box decommission): subnet_snapshots is
// dual-written to D1 (#9036), and with a `db` binding this runs the
// pre-elimination windowed query there. Without one it keeps the
// schema-stable empty shape every caller has served on a tier miss since
// 2026-07-17.

import {
  buildEconomicsTrends,
  DEFAULT_HISTORY_WINDOW,
  parseHistoryWindow,
} from "./neuron-history.ts";
import { d1All, type ObservationsReadDb } from "./analytics-live.ts";
import { DAY_MS } from "../workers/config.ts";

// ~129 netuids (128 subnets + root) × 365 days ≈ 47k rows for `all`;
// generous but finite.
export const ECONOMICS_TRENDS_ROW_CAP = 60000;

export function parseEconomicsTrendsWindow(
  window: unknown,
): { label: string; days: number | null } | null {
  const parsed = parseHistoryWindow(
    window === undefined || window === null ? DEFAULT_HISTORY_WINDOW : window,
  );
  if ("error" in parsed) return null;
  return { label: parsed.label, days: parsed.days };
}

export async function loadEconomicsTrends({
  windowLabel,
  windowDays = null,
  db = null,
  now = Date.now(),
}: {
  windowLabel?: string;
  windowDays?: number | null;
  db?: ObservationsReadDb | null;
  now?: number;
} = {}): Promise<{
  data: Record<string, unknown>;
  rows: unknown[];
}> {
  const params: unknown[] = [];
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
  const rows = await d1All(db, sql, params);
  // Hitting the LIMIT means the oldest snapshot_date is truncated mid-day;
  // flag it so buildEconomicsTrends drops that partial day (the pre-elimination
  // contract, mirroring loadSubnetConcentrationHistory).
  const data = buildEconomicsTrends(rows, {
    window: windowLabel,
    capped: rows.length >= ECONOMICS_TRENDS_ROW_CAP,
  });
  return { data, rows };
}
