// Bittensor RPC endpoint list loader for MCP parity on GET /api/v1/rpc/endpoints.
// Applies the same list-query transforms as the REST route over the baked
// /metagraph/rpc-endpoints.json artifact.

import { applyQueryFilters } from "../workers/list-query.mjs";
import { API_QUERY_COLLECTIONS, QUERY_ENUMS } from "./contracts.mjs";

export const RPC_ENDPOINTS_ARTIFACT = "/metagraph/rpc-endpoints.json";

const ENDPOINT_SORT_FIELDS = API_QUERY_COLLECTIONS.endpoints.sort_fields;
const SURFACE_KINDS = QUERY_ENUMS.surfaceKind;
const ENDPOINT_LAYERS = QUERY_ENUMS.endpointLayer;
const PUBLICATION_STATES = QUERY_ENUMS.endpointPublicationState;
const HEALTH_STATUSES = QUERY_ENUMS.healthStatus;
const BOOLEAN_STRINGS = ["true", "false"];

export function rpcEndpointsMcpError(code, message) {
  const error = new Error(message);
  error.toolError = true;
  error.code = code;
  return error;
}

function optionalString(args, key) {
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

function optionalEnum(args, key, allowed) {
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

function optionalNumber(args, key) {
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

function clampLimit(value, fallback, max) {
  if (typeof value !== "number") return fallback;
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.min(max, Math.floor(value));
}

export function rpcEndpointsQueryUrl(args) {
  const url = new URL("https://mcp.internal/rpc/endpoints");
  if (args?.netuid !== undefined) {
    if (!Number.isInteger(args.netuid) || args.netuid < 0) {
      throw rpcEndpointsMcpError(
        "invalid_params",
        "netuid must be a non-negative integer.",
      );
    }
    url.searchParams.set("netuid", String(args.netuid));
  }
  const kind = optionalEnum(args, "kind", SURFACE_KINDS);
  if (kind) url.searchParams.set("kind", kind);
  const layer = optionalEnum(args, "layer", ENDPOINT_LAYERS);
  if (layer) url.searchParams.set("layer", layer);
  const poolEligible = optionalEnum(args, "pool_eligible", BOOLEAN_STRINGS);
  if (poolEligible) url.searchParams.set("pool_eligible", poolEligible);
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
  const minLatencyMs = optionalNumber(args, "min_latency_ms");
  if (minLatencyMs !== null) {
    url.searchParams.set("min_latency_ms", String(minLatencyMs));
  }
  const maxLatencyMs = optionalNumber(args, "max_latency_ms");
  if (maxLatencyMs !== null) {
    url.searchParams.set("max_latency_ms", String(maxLatencyMs));
  }
  const minScore = optionalNumber(args, "min_score");
  if (minScore !== null) url.searchParams.set("min_score", String(minScore));
  const maxScore = optionalNumber(args, "max_score");
  if (maxScore !== null) url.searchParams.set("max_score", String(maxScore));
  const sort = optionalEnum(args, "sort", ENDPOINT_SORT_FIELDS);
  if (sort) url.searchParams.set("sort", sort);
  const order = optionalEnum(args, "order", ["asc", "desc"]);
  if (order) url.searchParams.set("order", order);
  const fields = optionalString(args, "fields");
  if (fields) url.searchParams.set("fields", fields);
  if (args?.limit !== undefined) {
    url.searchParams.set("limit", String(clampLimit(args.limit, 50, 100)));
  }
  if (args?.cursor !== undefined) {
    if (!Number.isInteger(args.cursor) || args.cursor < 0) {
      throw rpcEndpointsMcpError(
        "invalid_params",
        "cursor must be a non-negative integer.",
      );
    }
    url.searchParams.set("cursor", String(args.cursor));
  }
  return url;
}

export async function loadRpcEndpointsList(ctx, args, { readArtifact } = {}) {
  const queryUrl = rpcEndpointsQueryUrl(args);
  const read = readArtifact ?? ctx.readArtifact;
  const result = await read(ctx.env, RPC_ENDPOINTS_ARTIFACT);
  if (!result?.ok) {
    const code = result?.code || "artifact_unavailable";
    if (code === "artifact_not_found") {
      throw rpcEndpointsMcpError(
        "not_found",
        "Bittensor RPC endpoint catalog unavailable.",
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
      "Bittensor RPC endpoint catalog unavailable.",
    );
  }
  const transformed = applyQueryFilters(blob, queryUrl, "endpoints", []);
  if (transformed.error) {
    throw rpcEndpointsMcpError("invalid_params", transformed.error.message);
  }
  const { data, meta } = transformed;
  const page = meta.pagination || {};
  const rows = Array.isArray(data.endpoints) ? data.endpoints : [];
  const rowLen = rows.length;
  return {
    generated_at: data.generated_at ?? null,
    schema_version: data.schema_version ?? null,
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

export const LIST_RPC_ENDPOINTS_INSTRUCTIONS =
  "Use list_rpc_endpoints to page the monitored Bittensor RPC endpoint catalog " +
  "with REST list-query filters (layer, status, latency/score bounds, and " +
  "pagination; mirrors GET /api/v1/rpc/endpoints), ";

export const LIST_RPC_ENDPOINTS_MCP_TOOL = {
  name: "list_rpc_endpoints",
  title: "List Bittensor RPC endpoints",
  description:
    "Fetch the catalog of monitored Bittensor base-layer RPC endpoints and " +
    "their status (each endpoint's URL, network, and probe-derived health/latency). " +
    "Filter by kind, layer, netuid, provider, publication_state, status, or " +
    "pool_eligible; bound latency_ms and score with min_/max_ params; sort with " +
    "sort + order; project with fields; and page with limit (1-100) / cursor. " +
    "Use get_best_rpc_endpoint to pick one live-healthy endpoint. Mirrors " +
    "GET /api/v1/rpc/endpoints.",
  inputSchema: {
    type: "object",
    properties: {
      netuid: {
        type: "integer",
        description: "Optional filter by subnet netuid when present on rows.",
        minimum: 0,
      },
      kind: {
        type: "string",
        enum: SURFACE_KINDS,
        description: "Filter by surface kind.",
      },
      layer: {
        type: "string",
        enum: ENDPOINT_LAYERS,
        description: "Filter by endpoint layer.",
      },
      provider: {
        type: "string",
        description: "Filter by provider slug.",
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
        type: "string",
        enum: BOOLEAN_STRINGS,
        description: "Filter by whether the endpoint is pool-eligible.",
      },
      min_latency_ms: {
        type: "number",
        description: "Inclusive minimum probe latency in milliseconds.",
      },
      max_latency_ms: {
        type: "number",
        description: "Inclusive maximum probe latency in milliseconds.",
      },
      min_score: {
        type: "number",
        description: "Inclusive minimum probe score.",
      },
      max_score: {
        type: "number",
        description: "Inclusive maximum probe score.",
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
    schema_version: { type: ["string", "integer", "null"] },
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
