// Shared RPC reverse-proxy usage analytics D1 loader for REST + MCP parity.
// Pure orchestration over rpc_proxy_events rows + formatRpcUsage; REST handlers
// keep edge-cache + envelope wiring.

import {
  ANALYTICS_WINDOWS,
  DAY_MS,
  RPC_USAGE_BUCKETS,
} from "../workers/config.mjs";
import { formatRpcUsage } from "./health-serving.mjs";

// RPC reverse-proxy usage analytics (B3): request volume, latency p50/p95,
// failover + error rate, cache-hit rate, per-endpoint distribution, and bounded
// time buckets. `d1` is a (sql, params) => rows runner — d1Runner(env) in the
// Worker, mcpD1Runner(ctx) in the MCP server.
export async function loadRpcUsage(
  d1,
  { window = "7d", observedAt = null, now = Date.now() } = {},
) {
  const windowLabel = Object.hasOwn(ANALYTICS_WINDOWS, window) ? window : "7d";
  const days = ANALYTICS_WINDOWS[windowLabel];
  const since = now - days * DAY_MS;
  const bucketConfig = RPC_USAGE_BUCKETS[windowLabel];
  const [totalsRows, latencyRows, endpointRows, networkRows, bucketRows] =
    await Promise.all([
      d1(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS ok_count,
                SUM(CASE WHEN attempts > 1 THEN 1 ELSE 0 END) AS failover_count,
                SUM(CASE WHEN cache = 'hit' THEN 1 ELSE 0 END) AS cache_hits,
                AVG(latency_ms) AS avg_latency_ms
         FROM rpc_proxy_events
         WHERE observed_at >= ?`,
        [since],
      ),
      d1(
        `WITH ranked AS (
           SELECT latency_ms,
                  ROW_NUMBER() OVER (ORDER BY latency_ms) AS rn,
                  COUNT(*) OVER () AS cnt
           FROM rpc_proxy_events
           WHERE observed_at >= ? AND latency_ms IS NOT NULL
         )
         SELECT MAX(CASE WHEN rn = CAST(0.50 * cnt AS INTEGER) + (0.50 * cnt > CAST(0.50 * cnt AS INTEGER)) THEN latency_ms END) AS p50,
                MAX(CASE WHEN rn = CAST(0.95 * cnt AS INTEGER) + (0.95 * cnt > CAST(0.95 * cnt AS INTEGER)) THEN latency_ms END) AS p95
         FROM ranked`,
        [since],
      ),
      d1(
        `SELECT endpoint_id, provider,
                COUNT(*) AS requests,
                SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS ok_count,
                AVG(latency_ms) AS avg_latency_ms
         FROM rpc_proxy_events
         WHERE observed_at >= ? AND endpoint_id IS NOT NULL
         GROUP BY endpoint_id, provider
         ORDER BY requests DESC
         LIMIT 50`,
        [since],
      ),
      d1(
        `SELECT network,
                COUNT(*) AS requests,
                SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS ok_count
         FROM rpc_proxy_events
         WHERE observed_at >= ?
         GROUP BY network
         ORDER BY requests DESC`,
        [since],
      ),
      d1(
        `SELECT ts, requests, errors, avg_latency_ms FROM (
           SELECT CAST(observed_at / ? AS INTEGER) * ? AS ts,
                  COUNT(*) AS requests,
                  SUM(CASE WHEN ok = 1 THEN 0 ELSE 1 END) AS errors,
                  AVG(latency_ms) AS avg_latency_ms
           FROM rpc_proxy_events
           WHERE observed_at >= ?
           GROUP BY ts
           ORDER BY ts DESC
           LIMIT ?
         )
         ORDER BY ts ASC`,
        [
          bucketConfig.bucketMs,
          bucketConfig.bucketMs,
          since,
          bucketConfig.maxBuckets,
        ],
      ),
    ]);
  return formatRpcUsage({
    window: windowLabel,
    observedAt,
    totals: totalsRows[0],
    latency: latencyRows[0],
    endpointRows,
    networkRows,
    bucketRows,
    bucketGranularity: bucketConfig.granularity,
  });
}
