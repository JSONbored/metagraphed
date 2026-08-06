// MCP tools `get_rpc_usage`, `get_best_rpc_endpoint`, `call_rpc`
// (types-epic E batch 12, #8075). All three are defined inline in
// src/mcp-server.ts's MCP_TOOLS array. None mirror an existing
// schemas-src/routes/ REST schema -- modeled fresh, matching each
// hand-written literal field-for-field. Unlike this epic's objectItems()-
// built array items (which never declare item-level `required`),
// get_rpc_usage's four nested shapes (summary/latency_ms/endpoints/
// networks/buckets, formerly mcp-server.ts's own RPC_USAGE_* constants) DO
// declare real item-level required fields -- preserved exactly, not loosened
// to match this epic's usual item-shape convention.
import { z } from "zod";
import { McpNetworkSchema } from "../shared.ts";
import { OpenObjectSchema, limitSchema, windowSchema } from "./shared.ts";
import {
  SAFE_RPC_METHODS,
  SAFE_RPC_STATE_QUERY_METHODS,
} from "../../workers/config.ts";

const RpcUsageLatencyMsSchema = z
  .object({
    p50: z.int().nullable(),
    p95: z.int().nullable(),
    avg: z.int().nullable(),
  })
  .passthrough();

const RpcUsageSummarySchema = z
  .object({
    total_requests: z.int().min(0),
    ok_requests: z.int().min(0),
    error_requests: z.int().min(0),
    error_rate: z.number().nullable().optional(),
    failover_requests: z.int().min(0).optional(),
    failover_rate: z.number().nullable().optional(),
    cache_hits: z.int().min(0).optional(),
    cache_hit_rate: z.number().nullable().optional(),
    latency_ms: RpcUsageLatencyMsSchema,
  })
  .passthrough();

const RpcUsageEndpointItemSchema = z
  .object({
    rank: z.int().min(1).optional(),
    endpoint_id: z.string().nullable(),
    provider: z.string().nullable().optional(),
    requests: z.int().min(0),
    ok_requests: z.int().min(0),
    error_rate: z.number().nullable().optional(),
    avg_latency_ms: z.int().nullable().optional(),
  })
  .passthrough();

const RpcUsageNetworkItemSchema = z
  .object({
    network: z.string(),
    requests: z.int().min(0),
    ok_requests: z.int().min(0),
    error_rate: z.number().nullable().optional(),
  })
  .passthrough();

const RpcUsageBucketItemSchema = z
  .object({
    ts: z.int().min(0),
    requests: z.int().min(0),
    errors: z.int().min(0),
    avg_latency_ms: z.int().nullable(),
  })
  .passthrough();

export const GetRpcUsageInputSchema = z
  .object({
    window: windowSchema(["7d", "30d"]).optional(),
  })
  .strict();
export type GetRpcUsageInput = z.infer<typeof GetRpcUsageInputSchema>;

// The measured span, per contributing store -- see RpcUsageArtifactSchema in
// schemas-src/routes/providers-rpc.ts for why `window` alone is not enough.
const RpcUsageCoverageRangeItemSchema = z
  .object({
    start: z.int().nullable(),
    end: z.int().nullable(),
  })
  .passthrough();

const RpcUsageCoverageSegmentItemSchema = z
  .object({
    source: z.string(),
    start: z.int().nullable(),
    end: z.int().nullable(),
  })
  .passthrough();

const RpcUsageCoverageItemSchema = z
  .object({
    start: z.int().nullable(),
    end: z.int().nullable(),
    segments: z.array(RpcUsageCoverageSegmentItemSchema),
    latency_percentiles: RpcUsageCoverageRangeItemSchema.nullable(),
  })
  .passthrough();

export const GetRpcUsageOutputSchema = z
  .object({
    schema_version: z.int(),
    window: z.string().nullable().optional(),
    bucket_granularity: z.string().nullable().optional(),
    observed_at: z.string().nullable().optional(),
    source: z.string(),
    coverage: RpcUsageCoverageItemSchema,
    summary: RpcUsageSummarySchema,
    endpoints: z.array(RpcUsageEndpointItemSchema),
    networks: z.array(RpcUsageNetworkItemSchema),
    buckets: z.array(RpcUsageBucketItemSchema),
  })
  .passthrough();
export type GetRpcUsageOutput = z.infer<typeof GetRpcUsageOutputSchema>;

export const GetBestRpcEndpointInputSchema = z
  .object({
    limit: limitSchema(10).optional(),
  })
  .strict();
export type GetBestRpcEndpointInput = z.infer<
  typeof GetBestRpcEndpointInputSchema
>;

const BestRpcEndpointItemSchema = z
  .object({
    id: z.string().optional(),
    url: z.string().nullable().optional(),
    provider: z.string().nullable().optional(),
    kind: z.string().nullable().optional(),
    score: z.unknown().optional(),
    latency_ms: z.int().nullable().optional(),
    status: z.string().nullable().optional(),
    health_source: z.string().nullable().optional(),
  })
  .passthrough();

export const GetBestRpcEndpointOutputSchema = z
  .object({
    eligible_count: z.int(),
    live_health: z.unknown().optional(),
    endpoints: z.array(BestRpcEndpointItemSchema),
  })
  .passthrough();
export type GetBestRpcEndpointOutput = z.infer<
  typeof GetBestRpcEndpointOutputSchema
>;

export const CallRpcInputSchema = z
  .object({
    // A hard allowlist, so it ships as one. The description spelled all thirteen
    // methods out in prose while the schema said "any string", which meant an agent had
    // to read English to avoid a guaranteed rejection — and `call_subnet_surface.method`
    // right beside it already declared its enum. Read from the same sets the proxy
    // enforces, so a method added there cannot be missing here.
    method: z
      .enum(
        [...SAFE_RPC_METHODS, ...SAFE_RPC_STATE_QUERY_METHODS].sort() as [
          string,
          ...string[],
        ],
      )
      .describe(
        "The JSON-RPC method to call. Restricted to a read-only allowlist — " +
          "the enum is the complete set, and it is the same set the proxy " +
          "enforces, so anything absent here is refused rather than forwarded.",
      )
      .meta({ examples: [...SAFE_RPC_METHODS] }),
    params: z
      .array(z.unknown())
      .optional()
      .describe(
        "Positional or named parameters for the RPC method, matching what that method expects.",
      )
      .meta({ examples: [[]] }),
    network: McpNetworkSchema.optional(),
  })
  .strict();
export type CallRpcInput = z.infer<typeof CallRpcInputSchema>;

export const CallRpcOutputSchema = z
  .object({
    network: z.string(),
    method: z.string(),
    jsonrpc: z.string(),
    result: z.unknown().optional(),
    error: OpenObjectSchema.nullable().optional(),
    endpoint_id: z.string().nullable().optional(),
    provider: z.string().nullable().optional(),
    cache: z.string().nullable().optional(),
  })
  .passthrough();
export type CallRpcOutput = z.infer<typeof CallRpcOutputSchema>;
