// Shared RPC reverse-proxy usage analytics loader for REST + MCP parity.
//
// D1 fully eliminated (2026-07-17): rpc_proxy_events is Postgres-only now
// (both callers try the Postgres tier first) -- this loader is only reached
// on a tier miss, so it always returns the schema-stable empty shape.

import { ANALYTICS_WINDOWS, RPC_USAGE_BUCKETS } from "../workers/config.ts";
import { formatRpcUsage } from "./health-serving.ts";

export async function loadRpcUsage({
  window = "7d",
  observedAt = null,
}: { window?: string; observedAt?: unknown } = {}): Promise<
  Record<string, unknown>
> {
  const windowLabel = Object.hasOwn(ANALYTICS_WINDOWS, window) ? window : "7d";
  const bucketConfig = (
    RPC_USAGE_BUCKETS as Record<string, { granularity: string }>
  )[windowLabel];
  return formatRpcUsage({
    window: windowLabel,
    observedAt,
    totals: undefined,
    latency: undefined,
    endpointRows: [],
    networkRows: [],
    bucketRows: [],
    bucketGranularity: bucketConfig.granularity,
  });
}
