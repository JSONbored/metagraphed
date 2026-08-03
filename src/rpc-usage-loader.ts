// The ZEROED FLOOR for /api/v1/rpc/usage -- a schema-stable empty card, with
// `coverage` reporting no segments at all because nothing was measured.
//
// Reachable ONLY from src/rpc-usage-answer.ts, and only when every store
// declined. That restriction is the whole point: this shape is correct when
// no store had anything to say and WRONG whenever one did, and #9269 was
// exactly that -- the MCP tool and the GraphQL resolver reached it directly
// while two live stores held the data, reporting zero requests in seven days
// to callers who could not tell that apart from an idle proxy.

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
