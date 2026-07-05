// Endpoint pool list loader for MCP parity on GET /api/v1/endpoint-pools.
// Applies the same list-query transforms as the REST route over the baked
// /metagraph/endpoint-pools.json artifact.

import { applyQueryFilters } from "../workers/list-query.mjs";
import { API_QUERY_COLLECTIONS } from "./contracts.mjs";

export const ENDPOINT_POOLS_ARTIFACT = "/metagraph/endpoint-pools.json";

const POOL_SORT_FIELDS = API_QUERY_COLLECTIONS["endpoint-pools"].sort_fields;
const POOL_KINDS = ["subtensor-rpc", "subtensor-wss", "archive"];

export function endpointPoolsMcpError(code, message) {
  const error = new Error(message);
  error.toolError = true;
  error.code = code;
  return error;
}

function optionalString(args, key) {
  const value = args?.[key];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim() === "") {
    throw endpointPoolsMcpError(
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
    throw endpointPoolsMcpError(
      "invalid_params",
      `Argument \`${key}\` must be one of: ${allowed.join(", ")}.`,
    );
  }
  return value;
}

function optionalRangeBound(args, key) {
  const value = args?.[key];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw endpointPoolsMcpError(
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

export function endpointPoolsQueryUrl(args) {
  const url = new URL("https://mcp.internal/endpoint-pools");
  const id = optionalString(args, "id");
  if (id) url.searchParams.set("id", id);
  const kind = optionalEnum(args, "kind", POOL_KINDS);
  if (kind) url.searchParams.set("kind", kind);
  const sort = optionalEnum(args, "sort", POOL_SORT_FIELDS);
  if (sort) url.searchParams.set("sort", sort);
  const order = optionalEnum(args, "order", ["asc", "desc"]);
  if (order) url.searchParams.set("order", order);
  const fields = optionalString(args, "fields");
  if (fields) url.searchParams.set("fields", fields);
  const minEligible = optionalRangeBound(args, "min_eligible_count");
  if (minEligible !== null) {
    url.searchParams.set("min_eligible_count", String(minEligible));
  }
  const maxEligible = optionalRangeBound(args, "max_eligible_count");
  if (maxEligible !== null) {
    url.searchParams.set("max_eligible_count", String(maxEligible));
  }
  const minEndpoint = optionalRangeBound(args, "min_endpoint_count");
  if (minEndpoint !== null) {
    url.searchParams.set("min_endpoint_count", String(minEndpoint));
  }
  const maxEndpoint = optionalRangeBound(args, "max_endpoint_count");
  if (maxEndpoint !== null) {
    url.searchParams.set("max_endpoint_count", String(maxEndpoint));
  }
  if (args?.limit !== undefined) {
    url.searchParams.set("limit", String(clampLimit(args.limit, 50, 100)));
  }
  if (args?.cursor !== undefined) {
    if (!Number.isInteger(args.cursor) || args.cursor < 0) {
      throw endpointPoolsMcpError(
        "invalid_params",
        "cursor must be a non-negative integer.",
      );
    }
    url.searchParams.set("cursor", String(args.cursor));
  }
  return url;
}

export async function loadEndpointPoolsList(ctx, args, { readArtifact } = {}) {
  const queryUrl = endpointPoolsQueryUrl(args);
  const read = readArtifact ?? ctx.readArtifact;
  const result = await read(ctx.env, ENDPOINT_POOLS_ARTIFACT);
  if (!result?.ok) {
    const code = result?.code || "artifact_unavailable";
    if (code === "artifact_not_found") {
      throw endpointPoolsMcpError(
        "not_found",
        "Endpoint pool snapshot unavailable.",
      );
    }
    throw endpointPoolsMcpError(
      code,
      `Could not load ${ENDPOINT_POOLS_ARTIFACT} (${code}).`,
    );
  }
  const blob = result.data;
  if (!blob || typeof blob !== "object") {
    throw endpointPoolsMcpError(
      "not_found",
      "Endpoint pool snapshot unavailable.",
    );
  }
  const transformed = applyQueryFilters(blob, queryUrl, "endpoint-pools", []);
  if (transformed.error) {
    throw endpointPoolsMcpError("invalid_params", transformed.error.message);
  }
  const { data, meta } = transformed;
  const page = meta.pagination || {};
  const rows = Array.isArray(data.pools) ? data.pools : [];
  const rowLen = rows.length;
  return {
    generated_at: data.generated_at ?? null,
    notes: data.notes ?? null,
    pools: rows,
    total: page.total ?? rowLen,
    returned: page.returned ?? rowLen,
    limit: page.limit ?? rowLen,
    cursor: page.cursor ?? 0,
    next_cursor: page.next_cursor ?? null,
    sort: page.sort ?? null,
    order: page.order ?? null,
  };
}

export const LIST_ENDPOINT_POOLS_INSTRUCTIONS =
  "list_endpoint_pools generalized endpoint pool scores (eligible/endpoint counts; " +
  "mirrors GET /api/v1/endpoint-pools), ";

export const LIST_ENDPOINT_POOLS_MCP_TOOL = {
  name: "list_endpoint_pools",
  title: "List generalized endpoint pools",
  description:
    "Fetch generalized endpoint pool scores from the registry: each pool's kind, " +
    "eligible endpoint count, total endpoint count, and probe-derived routing score. " +
    "Filter by id or kind, threshold with min_/max_eligible_count and " +
    "min_/max_endpoint_count, sort with sort + order, and page with limit (1-100) / " +
    "cursor. Complements list_endpoints (individual resources) and list_rpc_pools " +
    "(Bittensor RPC proxy pools). Mirrors GET /api/v1/endpoint-pools.",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "Filter to one pool id, e.g. 'finney-rpc'.",
      },
      kind: {
        type: "string",
        enum: POOL_KINDS,
        description: "Filter by pool kind.",
      },
      min_eligible_count: {
        type: "number",
        description: "Keep pools with eligible_count >= this bound.",
      },
      max_eligible_count: {
        type: "number",
        description: "Keep pools with eligible_count <= this bound.",
      },
      min_endpoint_count: {
        type: "number",
        description: "Keep pools with endpoint_count >= this bound.",
      },
      max_endpoint_count: {
        type: "number",
        description: "Keep pools with endpoint_count <= this bound.",
      },
      sort: {
        type: "string",
        enum: POOL_SORT_FIELDS,
        description: "Field to sort by before paging.",
      },
      order: {
        type: "string",
        enum: ["asc", "desc"],
        description: "Sort direction for sort (default asc).",
      },
      fields: {
        type: "string",
        description: "Comma-separated projection of pool row fields to return.",
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

export const LIST_ENDPOINT_POOLS_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: ["pools"],
  properties: {
    generated_at: NULLABLE_STRING,
    notes: {
      type: ["array", "string", "null"],
      items: { type: "string" },
    },
    pools: { type: "array", items: { type: "object" } },
    total: { type: "integer" },
    returned: { type: "integer" },
    limit: { type: "integer" },
    cursor: { type: "integer" },
    next_cursor: NULLABLE_INT,
    sort: NULLABLE_STRING,
    order: NULLABLE_STRING,
  },
};
