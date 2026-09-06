// RPC endpoint list loader for MCP parity on GET /api/v1/rpc/endpoints (#7893).
// Applies the same list-query transforms as the REST route over the baked
// /metagraph/rpc-endpoints.json artifact, after the live 15-minute cron overlay
// (mergeRpcEndpoints) — same order REST's liveHealthOverlay ->
// applyQueryFilters pipeline uses for the "rpc-endpoints" route id, so a
// filter like status or min_/max_latency_ms reads live health, not a stale
// baked value. GraphQL rpc_endpoints (#7966) shares this loader. Structurally
// mirrors provider-endpoints-mcp.ts (endpoints collection filters) and
// rpc-pools-mcp.ts (live overlay before filter).

import { applyMcpQueryFilters, type Row } from "./mcp-list-query.ts";
import type { StorageReadResult } from "../workers/storage.ts";
import { API_QUERY_COLLECTIONS, QUERY_ENUMS } from "./contracts.ts";
import { KV_HEALTH_RPC_POOL } from "./health-prober.ts";
import { mergeRpcEndpoints } from "./health-serving.ts";
import {
  ListRpcEndpointsInputSchema,
  ListRpcEndpointsOutputSchema,
} from "../schemas-src/mcp-tools/registry-catalogs-2.ts";
import { inputJsonSchema, outputJsonSchema } from "./mcp-input-schema.ts";
import { recordOrNull } from "./read-store.ts";

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
  // `readonly` since QUERY_ENUMS became `as const` (#10060) -- the vocabularies
  // are frozen tuples now so a consumer can hand one to `z.enum()` rather than
  // writing the values out again.
  allowed: readonly string[],
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

function resolveFieldsProjection(
  args: Record<string, unknown> | null | undefined,
): string | null {
  const value = args?.fields;
  if (value === undefined || value === null || value === "") return null;
  if (Array.isArray(value)) {
    const parts = value
      .filter((part): part is string => typeof part === "string")
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length === 0) {
      throw rpcEndpointsMcpError(
        "invalid_params",
        "Argument `fields` must be a non-empty list of field names when provided.",
      );
    }
    return parts.join(",");
  }
  return optionalString(args, "fields");
}

function resolveCursor(
  args: Record<string, unknown> | null | undefined,
): number | null {
  const value = args?.cursor;
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string") {
    if (!/^\d+$/.test(value.trim())) {
      throw rpcEndpointsMcpError(
        "invalid_params",
        "cursor must be a non-negative integer.",
      );
    }
    return Number(value.trim());
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw rpcEndpointsMcpError(
      "invalid_params",
      "cursor must be a non-negative integer.",
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
  const q = ListRpcEndpointsInputSchema.shape.q.safeParse(args?.q);
  if (!q.success) {
    throw rpcEndpointsMcpError("invalid_params", q.error.issues[0].message);
  }
  if (q.data !== undefined) url.searchParams.set("q", q.data);
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
  for (const key of ["pool_eligible", "known_status"]) {
    if (args?.[key] === undefined || args[key] === null) continue;
    if (typeof args[key] !== "boolean") {
      throw rpcEndpointsMcpError(
        "invalid_params",
        `${key} must be a boolean when provided.`,
      );
    }
    url.searchParams.set(key, String(args[key]));
  }
  const sort = optionalEnum(args, "sort", ENDPOINT_SORT_FIELDS);
  if (sort) url.searchParams.set("sort", sort);
  const order = optionalEnum(args, "order", ["asc", "desc"]);
  if (order) url.searchParams.set("order", order);
  const fields = resolveFieldsProjection(args);
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
    // #8830: reject an out-of-range limit rather than silently clamping, so this
    // tool matches its sibling list_endpoints (src/mcp-server.ts:8760-8762) and
    // the REST route it proxies. An absent limit still defaults to 50 downstream.
    const limit = args.limit;
    if (
      typeof limit !== "number" ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 1000
    ) {
      throw rpcEndpointsMcpError(
        "invalid_params",
        "limit must be an integer between 1 and 1000.",
      );
    }
    url.searchParams.set("limit", String(limit));
  }
  const cursor = resolveCursor(args);
  if (cursor !== null) url.searchParams.set("cursor", String(cursor));
  return url;
}

export interface RpcEndpointsListResult {
  generated_at: unknown;
  notes: unknown;
  schema_version: unknown;
  summary: unknown;
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

type RpcEndpointsCtx = {
  env: Env;
  readArtifact: (env: Env, path: string) => Promise<StorageReadResult>;
  // `unknown`, matching workers/storage.ts's actual return: KV holds whatever
  // the 15-minute cron last wrote as JSON. Declaring an object here was a claim
  // about untrusted bytes that nothing checked (#11339) -- `recordOrNull` at
  // the point of use is what checks it now.
  readHealthKv?: (env: Env, key: string) => Promise<unknown>;
};

export async function loadRpcEndpointsList(
  ctx: RpcEndpointsCtx,
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
        "RPC endpoints catalog snapshot unavailable.",
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
      "RPC endpoints catalog snapshot unavailable.",
    );
  }

  // Live overlay matching GraphQL/REST: with no live snapshot the static
  // catalog passes through; with a snapshot, mergeRpcEndpoints replaces
  // stale build-time health/latency before filters run.
  let overlaid = blob as Record<string, unknown>;
  const livePool = ctx.readHealthKv
    ? recordOrNull(await ctx.readHealthKv(ctx.env, KV_HEALTH_RPC_POOL))
    : null;
  if (livePool) {
    const merged = mergeRpcEndpoints(overlaid, livePool);
    if (merged) overlaid = merged as Record<string, unknown>;
  }

  const transformed = applyMcpQueryFilters(overlaid, queryUrl, "endpoints", []);
  if (transformed.error) {
    throw rpcEndpointsMcpError("invalid_params", transformed.error.message);
  }
  const data = transformed.data as Record<string, unknown>;
  const meta = (transformed.meta ?? {}) as Record<string, unknown>;
  const page = (meta.pagination as Record<string, unknown>) || {};
  const rows = Array.isArray(data.endpoints) ? (data.endpoints as Row[]) : [];
  const rowLen = rows.length;
  return {
    generated_at: data.generated_at ?? null,
    notes: data.notes ?? null,
    schema_version: data.schema_version ?? null,
    summary: data.summary ?? null,
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
    "publication_state/status/known_status/pool_eligible, threshold with min_/" +
    "max_latency_ms and min_/max_score, sort with sort + order, and page " +
    "with limit / cursor. This is the full-catalog view; use " +
    "get_best_rpc_endpoint instead to pick one live-healthy endpoint. " +
    "Mirrors GET /api/v1/rpc/endpoints.",
  inputSchema: inputJsonSchema(ListRpcEndpointsInputSchema),
};

export const LIST_RPC_ENDPOINTS_OUTPUT_SCHEMA = outputJsonSchema(
  ListRpcEndpointsOutputSchema,
);
