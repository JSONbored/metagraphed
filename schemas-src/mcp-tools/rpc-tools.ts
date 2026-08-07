// MCP tools `get_rpc_usage`, `get_best_rpc_endpoint`, `call_rpc`
// (types-epic E batch 12, #8075). All three are defined inline in
// src/mcp-server.ts's MCP_TOOLS array.
//
// This header used to say none of the three "mirror an existing
// schemas-src/routes/ REST schema -- modeled fresh". For get_rpc_usage that was
// wrong: RpcUsageArtifactSchema in schemas-src/routes/providers-rpc.ts models
// the same bytes, and the fresh model disagreed with it on `observed_at`
// (#9794). It now reuses the route schema outright.
import { z } from "zod";
import { RpcUsageArtifactSchema } from "../routes/providers-rpc.ts";
import { McpNetworkSchema } from "../shared.ts";
import { OpenObjectSchema, limitSchema, windowSchema } from "./shared.ts";
import {
  SAFE_RPC_METHODS,
  SAFE_RPC_STATE_QUERY_METHODS,
} from "../../workers/config.ts";

export const GetRpcUsageInputSchema = z
  .object({
    window: windowSchema(["7d", "30d"]).optional(),
  })
  .strict();
export type GetRpcUsageInput = z.infer<typeof GetRpcUsageInputSchema>;

// DERIVED FROM THE ROUTE, NOT COPIED (#9794). This tool's `observed_at` is
// EPOCH MILLISECONDS -- the served value is 1786099339000 -- and this file
// declared a string, so every response failed its own published schema and an
// agent was told to expect a date it could parse as text.
//
// The route contract said `string` too, so unlike the sibling fixes in #9794
// this was not a copy drifting away from a correct source: the same field was
// written wrong twice, independently, which is the clearest argument there is
// for one declaration rather than two. Corrected at the source in
// schemas-src/routes/providers-rpc.ts -- which fixes GET /api/v1/rpc/usage at
// the same time -- and reused here. Verified against production after the
// change.
//
// The nine hand-written item schemas this file used to carry (latency_ms,
// summary, endpoints, networks, buckets and the three coverage shapes) are
// gone with it: RpcUsageArtifactSchema declares all of them, so keeping local
// copies would only recreate the divergence this issue exists to remove.
export const GetRpcUsageOutputSchema = RpcUsageArtifactSchema;
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
