// Shared chain-signers D1 loader for REST + MCP parity (#2342). Pure
// orchestration over extrinsics-tier rows + buildChainSigners; REST handlers keep
// edge-cache + envelope wiring.

import { DAY_MS } from "../workers/config.mjs";
import { buildChainFees, buildChainSigners } from "./chain-analytics.mjs";

// Windowed most-active-account leaderboard (#2342): signers ranked by extrinsic
// count over the window (ties broken by signer ASC for stable ordering).
// Optional call_module scopes to one pallet.
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
     ORDER BY tx_count DESC, signer ASC
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

// Fee/tip market analytics (#1988): per-UTC-day fee series plus a windowed
// top-fee-payer list. Shared by REST /chain/fees and get_chain_fees MCP tool.
export async function loadChainFees(
  d1Runner,
  {
    windowLabel,
    windowDays,
    observedAt = null,
    limit = 25,
    callModule = null,
    now = Date.now(),
  },
) {
  const cutoff = now - windowDays * DAY_MS;
  const moduleClause = callModule ? " AND call_module = ?" : "";
  const dailyParams = callModule ? [cutoff, callModule] : [cutoff];
  const payerParams = callModule
    ? [cutoff, callModule, limit]
    : [cutoff, limit];
  const [dailyRows, payerRows] = await Promise.all([
    d1Runner(
      `SELECT strftime('%Y-%m-%d', observed_at / 1000, 'unixepoch') AS day,
              COUNT(*) AS extrinsic_count,
              SUM(COALESCE(fee_tao, 0)) AS total_fee_tao,
              SUM(COALESCE(tip_tao, 0)) AS total_tip_tao
       FROM extrinsics
       WHERE observed_at >= ?${moduleClause}
       GROUP BY day`,
      dailyParams,
    ),
    d1Runner(
      `SELECT signer,
              SUM(COALESCE(fee_tao, 0)) AS total_fee_tao,
              SUM(COALESCE(tip_tao, 0)) AS total_tip_tao,
              COUNT(*) AS extrinsic_count
       FROM extrinsics
       WHERE observed_at >= ? AND signer IS NOT NULL${moduleClause}
       GROUP BY signer
       ORDER BY total_fee_tao DESC
       LIMIT ?`,
      payerParams,
    ),
  ]);
  const data = buildChainFees({
    window: windowLabel,
    observedAt,
    dailyRows,
    payerRows,
  });
  return { data, dailyRows, payerRows };
}
