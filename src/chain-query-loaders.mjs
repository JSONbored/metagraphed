// Shared chain-signers D1 loader for REST + MCP parity (#2342). Pure
// orchestration over extrinsics-tier rows + buildChainSigners; REST handlers keep
// edge-cache + envelope wiring.

import { DAY_MS } from "../workers/config.mjs";
import { buildChainSigners } from "./chain-analytics.mjs";

export const CHAIN_SIGNERS_SORTS = ["tx_count", "total_fee_tao"];

function normalizeChainSignersSort(sort) {
  return CHAIN_SIGNERS_SORTS.includes(sort) ? sort : "tx_count";
}

// Windowed most-active-account leaderboard (#2342): signers ranked by extrinsic
// count or total fees over the window (ties broken by signer ASC for stable
// ordering). Optional call_module scopes to one pallet.
export async function loadChainSigners(
  d1Runner,
  {
    windowLabel,
    windowDays,
    observedAt = null,
    limit = 50,
    callModule = null,
    sort = "tx_count",
  },
) {
  const cutoff = Date.now() - windowDays * DAY_MS;
  const moduleClause = callModule ? " AND call_module = ?" : "";
  const params = callModule ? [cutoff, callModule, limit] : [cutoff, limit];
  const sortBy = normalizeChainSignersSort(sort);
  const rows = await d1Runner(
    `SELECT signer,
            COUNT(*) AS tx_count,
            SUM(COALESCE(fee_tao, 0)) AS total_fee_tao,
            SUM(COALESCE(tip_tao, 0)) AS total_tip_tao,
            MAX(block_number) AS last_tx_block
     FROM extrinsics
     WHERE observed_at >= ? AND signer IS NOT NULL${moduleClause}
     GROUP BY signer
     ORDER BY ${sortBy} DESC, signer ASC
     LIMIT ?`,
    params,
  );
  const data = buildChainSigners({
    window: windowLabel,
    sort: sortBy,
    observedAt,
    rows,
  });
  return { data, rows };
}
