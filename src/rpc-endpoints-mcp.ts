// RPC endpoint list loader for MCP parity on GET /api/v1/rpc/endpoints (#7893).
// Applies the same list-query transforms as the REST route over the baked
// /metagraph/rpc-endpoints.json artifact, after the live 15-minute cron
// overlay (mergeRpcEndpoints) — same order REST's liveHealthOverlay ->
// applyQueryFilters pipeline uses for the "rpc-endpoints" route id, so a
// filter like status or min_/max_latency_ms reads live health, not a stale
// baked value. Structurally mirrors rpc-pools-mcp.ts (the closest sibling:
// same live-overlay-before-applyQueryFilters ordering over the shared
// "endpoints" query collection provider-endpoints-mcp.ts also uses).

import { applyQueryFilters, type Row } from "../workers/list-query.ts";
import type { StorageReadResult } from "../workers/storage.ts";
import { API_QUERY_COLLECTIONS, QUERY_ENUMS } from "./contracts.ts";
import { KV_HEALTH_RPC_POOL } from "./health-prober.ts";
import { mergeRpcEndpoints } from "./health-serving.ts";

export const RPC_ENDPOINTS_ARTIFACT = "/metagraph/rpc-endpoints.json";

const ENDPOINT_SORT_FIELDS = API_QUERY_COLLECTIONS.endpoints.sort_fields;
const SURFACE_KINDS = QUERY_ENUMS.surfaceKind;
const ENDPOINT_LAYERS = QUERY_ENUMS.endpointLayer;
const HEALTH_STATUSES = QUERY_ENUMS.healthStatus;
const PUBLICATION_STATES = QUERY_ENUMS.endpointPublicationState;

export interface RpcEndpointsMcpError extends Error {
  toolError: true;
  code: string;
}

export function rpcEndpointsMcpError(
  code: string,
  message: string,
): RpcEndpointsMcpError {
  const error = new Error(message) as RpcEndpointsMcpError;
  error.toolError = true;
  error.code = code;
  return error;
}

function optionalString(
  args: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const value = args?.[key];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim() === "") {
    throw rpcEndpointsMcpError(
      "invalid_params",
      `Argument \`${key}\` must be a non-empty string when provided.`,
    );
  }
  return value.trim();
}

function optionalEnum(
  args: Record<string, unknown> | null | undefined,
  key: string,
  allowed: string[],
): string | null {
  const value = args?.[key];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw rpcEndpointsMcpError(
      "invalid_params",
      `Argument \`${key}\` must be one of: ${allowed.join(", ")}.`,
    );
  }
  return value;
}

function optionalRangeBound(
  args: Record<string, unknown> | null | undefined,
  key: string,
): number | null {
  const value = args?.[key];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw rpcEndpointsMcpError(
      "invalid_params",
      `Argument \`${key}\` must be a finite number when provided.`,
    );
  }
  return value;
}

export function rpcEndpointsQueryUrl(
  args: Record<string, unknown> | null | undefined,
): URL {
  const url = new URL("https://mcp.internal/rpc-endpoints");
  if (args?.netuid !== undefined) {
    const netuid = args.netuid;
    if (typeof netuid !== "number" || !Number.isInteger(netuid) || netuid < 0) {
      throw rpcEndpointsMcpError(
        "invalid_params",
        "netuid must be a non-negative integer.",
      );
    }
    url.searchParams.set("netuid", String(netuid));
  }
  const kind = optionalEnum(args, "kind", SURFACE_KINDS);
  if (kind) url.searchParams.set("kind", kind);
  const layer = optionalEnum(args, "layer", ENDPOINT_LAYERS);
  if (layer) url.searchParams.set("layer", layer);
  const provider = optionalString(args, "provider");
  if (provider) url.searchParams.set("provider", provider);
  const publicationState = optionalEnum(
    args,
    "publication_state",
    PUBLICATION_STATES,
  );
  if (publicationState) {
    url.searchParams.set("publication_state", publicationState);
  }
  const status = optionalEnum(args, "status", HEALTH_STATUSES);
  if (status) url.searchParams.set("status", status);
  if (args?.pool_eligible !== undefined) {
    if (typeof args.pool_eligible !== "boolean") {
      throw rpcEndpointsMcpError(
        "invalid_params",
        "pool_eligible must be a boolean when provided.",
      );
    }
    url.searchParams.set("pool_eligible", String(args.pool_eligible));
  }
  const sort = optionalEnum(args, "sort", ENDPOINT_SORT_FIELDS);
  if (sort) url.searchParams.set("sort", sort);
  const order = optionalEnum(args, "order", ["asc", "desc"]);
  if (order) url.searchParams.set("order", order);
  const fields = optionalString(args, "fields");
  if (fields) url.searchParams.set("fields", fields);
  const minLatency = optionalRangeBound(args, "min_latency_ms");
  if (minLatency !== null) {
    url.searchParams.set("min_latency_ms", String(minLatency));
  }
  const maxLatency = optionalRangeBound(args, "max_latency_ms");
  if (maxLatency !== null) {
    url.searchParams.set("max_latency_ms", String(maxLatency));
  }
  const minScore = optionalRangeBound(args, "min_score");
  if (minScore !== null) url.searchParams.set("min_score", String(minScore));
  const maxScore = optionalRangeBound(args, "max_score");
  if (maxScore !== null) url.searchParams.set("max_score", String(maxScore));
  if (args?.limit !== undefined) {
    const limit = args.limit;
    if (
      typeof limit !== "number" ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      throw rpcEndpointsMcpError(
        "invalid_params",
        "limit must be an integer between 1 and 100.",
      );
    }
    url.searchParams.set("limit", String(limit));
  }
  if (args?.cursor !== undefined) {
    const cursor = args.cursor;
    if (typeof cursor !== "number" || !Number.isInteger(cursor) || cursor < 0) {
      throw rpcEndpointsMcpError(
        "invalid_params",
        "cursor must be a non-negative integer.",
      );
    }
    url.searchParams.set("cursor", String(cursor));
  }
  return url;
}

interface RpcEndpointsMcpCtx {
  env: Env;
  readArtifact: (env: Env, path: string) => Promise<StorageReadResult>;
  readHealthKv?: (
    env: Env,
    key: string,
  ) => Promise<Record<string, unknown> | null>;
}

export interface RpcEndpointsListResult {
  generated_at: unknown;
  notes: unknown;
  source: unknown;
  operational_observed_at: unknown;
  endpoints: Row[];
  total: unknown;
  returned: unknown;
  limit: unknown;
  cursor: unknown;
  next_cursor: unknown;
  sort: unknown;
  order: unknown;
}

export async function loadRpcEndpointsList(
  ctx: RpcEndpointsMcpCtx,
  args: Record<string, unknown> | null | undefined,
  {
    readArtifact,
  }: {
    readArtifact?: (env: Env, path: string) => Promise<StorageReadResult>;
  } = {},
): Promise<RpcEndpointsListResult> {
  const queryUrl = rpcEndpointsQueryUrl(args);
  const read = readArtifact ?? ctx.readArtifact;
  const result = await read(ctx.env, RPC_ENDPOINTS_ARTIFACT);
  if (!result?.ok) {
    const code =
      (result as { code?: string } | undefined)?.code || "artifact_unavailable";
    if (code === "artifact_not_found") {
      throw rpcEndpointsMcpError(
        "not_found",
        "RPC endpoint snapshot unavailable.",
      );
    }
    throw rpcEndpointsMcpError(
      code,
      `Could not load ${RPC_ENDPOINTS_ARTIFACT} (${code}).`,
    );
  }
  const blob = result.data;
  if (!blob || typeof blob !== "object") {
    throw rpcEndpointsMcpError(
      "not_found",
      "RPC endpoint snapshot unavailable.",
    );
  }

  // Live 15-minute cron overlay, matching REST's liveHealthOverlay for the
  // "rpc-endpoints" route id — applied before filtering so a filter like
  // status or the latency_ms/score bounds reads the current snapshot, not
  // the baked one. Falls back to the static artifact unchanged when there is
  // no live pool snapshot yet (mergeRpcEndpoints returns null in that case).
  let overlaid = blob as Record<string, unknown>;
  const livePool = ctx.readHealthKv
    ? await ctx.readHealthKv(ctx.env, KV_HEALTH_RPC_POOL)
    : null;
  const merged = livePool ? mergeRpcEndpoints(overlaid, livePool) : null;
  if (merged) overlaid = merged as Record<string, unknown>;

  const transformed = applyQueryFilters(overlaid, queryUrl, "endpoints", []);
  if (transformed.error) {
    throw rpcEndpointsMcpError("invalid_params", transformed.error.message);
  }
  const data = transformed.data as Record<string, unknown>;
  const meta = transformed.meta as Record<string, unknown>;
  const page = (meta.pagination as Record<string, unknown>) || {};
  const rows = Array.isArray(data.endpoints) ? (data.endpoints as Row[]) : [];
  const rowLen = rows.length;
  return {
    generated_at: data.generated_at ?? null,
    notes: data.notes ?? null,
    source: data.source ?? null,
    operational_observed_at: data.operational_observed_at ?? null,
    endpoints: rows,
    total: page.total ?? rowLen,
    returned: page.returned ?? rowLen,
    limit: page.limit ?? rowLen,
    cursor: page.cursor ?? 0,
    next_cursor: page.next_cursor ?? null,
    sort: page.sort ?? null,
    order: page.order ?? null,
  };
}

export const LIST_RPC_ENDPOINTS_MCP_TOOL = {
  name: "list_rpc_endpoints",
  title: "List Bittensor RPC endpoints",
  description:
    "Fetch the catalog of monitored Bittensor base-layer RPC endpoints and " +
    "their status (each endpoint's URL, network, and probe-derived " +
    "health/latency). Filter by kind/layer/netuid/provider/" +
    "publication_state/status/pool_eligible, threshold with min_/" +
    "max_latency_ms and min_/max_score, sort with sort + order, and page " +
    "with limit (1-100) / cursor. This is the full-catalog view; use " +
    "get_best_rpc_endpoint instead to pick one live-healthy endpoint. " +
    "Mirrors GET /api/v1/rpc/endpoints.",
  inputSchema: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: SURFACE_KINDS,
        description: "Surface kind, e.g. 'subtensor-rpc' or 'subtensor-wss'.",
      },
      layer: {
        type: "string",
        enum: ENDPOINT_LAYERS,
        description: "Endpoint layer, e.g. 'bittensor-base'.",
      },
      netuid: { type: "integer", description: "Subnet netuid.", minimum: 0 },
      provider: {
        type: "string",
        description: "Provider slug, e.g. 'opentensor'.",
      },
      publication_state: {
        type: "string",
        enum: PUBLICATION_STATES,
        description: "Filter by publication state.",
      },
      status: {
        type: "string",
        enum: HEALTH_STATUSES,
        description: "Filter by probe-derived health status.",
      },
      pool_eligible: {
        type: "boolean",
        description: "Only endpoints eligible (or not) for RPC pooling.",
      },
      min_latency_ms: {
        type: "number",
        description: "Keep endpoints with latency_ms >= this bound.",
      },
      max_latency_ms: {
        type: "number",
        description: "Keep endpoints with latency_ms <= this bound.",
      },
      min_score: {
        type: "number",
        description: "Keep endpoints with score >= this bound.",
      },
      max_score: {
        type: "number",
        description: "Keep endpoints with score <= this bound.",
      },
      sort: {
        type: "string",
        enum: ENDPOINT_SORT_FIELDS,
        description: "Field to sort by before paging.",
      },
      order: {
        type: "string",
        enum: ["asc", "desc"],
        description: "Sort direction for sort (default asc).",
      },
      fields: {
        type: "string",
        description:
          "Comma-separated projection of endpoint row fields to return.",
      },
      limit: {
        type: "integer",
        description: "Max rows to return (1-100). Enables pagination.",
        minimum: 1,
        maximum: 100,
      },
      cursor: {
        type: "integer",
        description: "Pagination cursor from a prior response's next_cursor.",
        minimum: 0,
      },
    },
    additionalProperties: false,
  },
};

const NULLABLE_STRING = { type: ["string", "null"] };
const NULLABLE_INT = { type: ["integer", "null"] };

export const LIST_RPC_ENDPOINTS_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: ["endpoints"],
  properties: {
    generated_at: NULLABLE_STRING,
    notes: {
      type: ["array", "string", "null"],
      items: { type: "string" },
    },
    source: NULLABLE_STRING,
    operational_observed_at: NULLABLE_STRING,
    endpoints: { type: "array", items: { type: "object" } },
    total: { type: "integer" },
    returned: { type: "integer" },
    limit: { type: "integer" },
    cursor: { type: "integer" },
    next_cursor: NULLABLE_INT,
    sort: NULLABLE_STRING,
    order: NULLABLE_STRING,
  },
};
