// Shared chain D1 query loaders for REST + MCP parity (#1990 signers, #1989 calls,
// #1988 fees). Pure orchestration over extrinsics-tier rows + chain-analytics
// builders; REST handlers keep edge-cache + envelope wiring.

import { DAY_MS } from "../workers/config.mjs";
import { buildChainSigners } from "./chain-analytics.mjs";

// Windowed most-active-account leaderboard (#1990): signers ranked by extrinsic
// count over the window. Optional call_module scopes to one pallet.
export async function loadChainSigners(
  d1Runner,
  { windowLabel, windowDays, observedAt = null, limit = 50, callModule = null },
) {
  const cutoff = Date.now() - windowDays * DAY_MS;
  const moduleClause = callModule ? " AND call_module = ?" : "";
  const params = callModule ? [cutoff, callModule, limit] : [cutoff, limit];
  const rows = await d1Runner(
    `SELECT signer,
            COUNT(*) AS tx_count,
            SUM(COALESCE(fee_tao, 0)) AS total_fee_tao,
            SUM(COALESCE(tip_tao, 0)) AS total_tip_tao,
            MAX(block_number) AS last_tx_block
     FROM extrinsics
     WHERE observed_at >= ? AND signer IS NOT NULL${moduleClause}
     GROUP BY signer
     ORDER BY tx_count DESC
     LIMIT ?`,
    params,
  );
  const data = buildChainSigners({
    window: windowLabel,
    observedAt,
    rows,
  });
  return { data, rows };
}
