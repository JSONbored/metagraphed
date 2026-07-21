// Provider endpoint list loader for MCP parity on
// GET /api/v1/providers/{slug}/endpoints. Applies the same list-query
// transforms as the REST route over the baked
// /metagraph/providers/{slug}/endpoints.json artifact.

import { applyQueryFilters } from "../workers/list-query.ts";
import { API_QUERY_COLLECTIONS, QUERY_ENUMS } from "./contracts.mjs";

export const PROVIDER_SLUG_PATTERN = /^[a-z0-9-]+$/;

const ENDPOINT_SORT_FIELDS = API_QUERY_COLLECTIONS.endpoints.sort_fields;
const SURFACE_KINDS = QUERY_ENUMS.surfaceKind;
const ENDPOINT_LAYERS = QUERY_ENUMS.endpointLayer;
const HEALTH_STATUSES = QUERY_ENUMS.healthStatus;
const PUBLICATION_STATES = QUERY_ENUMS.endpointPublicationState;

export function providerEndpointsArtifactPath(slug) {
  return `/metagraph/providers/${slug}/endpoints.json`;
}

export function providerEndpointsMcpError(code, message) {
  const error = new Error(message);
  error.toolError = true;
  error.code = code;
  return error;
}

function optionalString(args, key) {
  const value = args?.[key];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim() === "") {
    throw providerEndpointsMcpError(
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
    throw providerEndpointsMcpError(
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
    throw providerEndpointsMcpError(
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

export function parseProviderSlug(args) {
  const slug = args?.slug;
  if (typeof slug !== "string" || slug.trim() === "") {
    throw providerEndpointsMcpError(
      "invalid_params",
      "Argument `slug` must be a non-empty string.",
    );
  }
  const normalized = slug.trim();
  if (!PROVIDER_SLUG_PATTERN.test(normalized)) {
    throw providerEndpointsMcpError(
      "invalid_params",
      "slug must match ^[a-z0-9-]+$ (lowercase letters, digits, hyphens).",
    );
  }
  return normalized;
}

export function providerEndpointsQueryUrl(args) {
  const url = new URL("https://mcp.internal/provider-endpoints");
  if (args?.netuid !== undefined) {
    if (!Number.isInteger(args.netuid) || args.netuid < 0) {
      throw providerEndpointsMcpError(
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
      throw providerEndpointsMcpError(
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
    url.searchParams.set("limit", String(clampLimit(args.limit, 50, 100)));
  }
  if (args?.cursor !== undefined) {
    if (!Number.isInteger(args.cursor) || args.cursor < 0) {
      throw providerEndpointsMcpError(
        "invalid_params",
        "cursor must be a non-negative integer.",
      );
    }
    url.searchParams.set("cursor", String(args.cursor));
  }
  return url;
}

export async function loadProviderEndpointsList(
  ctx,
  args,
  { readArtifact } = {},
) {
  const slug = parseProviderSlug(args);
  const queryUrl = providerEndpointsQueryUrl(args);
  const artifactPath = providerEndpointsArtifactPath(slug);
  const read = readArtifact ?? ctx.readArtifact;
  const result = await read(ctx.env, artifactPath);
  if (!result?.ok) {
    const code = result?.code || "artifact_unavailable";
    if (code === "artifact_not_found") {
      throw providerEndpointsMcpError(
        "not_found",
        `No endpoint catalog exists for provider '${slug}'.`,
      );
    }
    throw providerEndpointsMcpError(
      code,
      `Could not load ${artifactPath} (${code}).`,
    );
  }
  const blob = result.data;
  if (!blob || typeof blob !== "object") {
    throw providerEndpointsMcpError(
      "not_found",
      `No endpoint catalog exists for provider '${slug}'.`,
    );
  }
  const transformed = applyQueryFilters(blob, queryUrl, "endpoints", []);
  if (transformed.error) {
    throw providerEndpointsMcpError(
      "invalid_params",
      transformed.error.message,
    );
  }
  const { data, meta } = transformed;
  const page = meta.pagination || {};
  const rows = Array.isArray(data.endpoints) ? data.endpoints : [];
  const rowLen = rows.length;
  return {
    slug,
    generated_at: data.generated_at ?? null,
    notes: data.notes ?? null,
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

export const LIST_PROVIDER_ENDPOINTS_INSTRUCTIONS =
  "list_provider_endpoints one provider's endpoint resources (filterable; " +
  "mirrors GET /api/v1/providers/{slug}/endpoints), ";

export const LIST_PROVIDER_ENDPOINTS_MCP_TOOL = {
  name: "list_provider_endpoints",
  title: "List one provider's endpoint resources",
  description:
    "Fetch the monitored endpoint resources for one provider by slug: each " +
    "endpoint/surface with its kind, layer, subnet (netuid), publication state, " +
    "and probe-derived status/latency/score. Filter by kind/layer/netuid/" +
    "publication_state/status/pool_eligible, threshold with min_/max_latency_ms " +
    "and min_/max_score, sort with sort + order, and page with limit (1-100) / " +
    "cursor. The per-provider view of list_endpoints (the network-wide catalog). " +
    "Complements get_provider_detail (identity + optional endpoints attachment). " +
    "Mirrors GET /api/v1/providers/{slug}/endpoints.",
  inputSchema: {
    type: "object",
    properties: {
      slug: {
        type: "string",
        pattern: "^[a-z0-9-]+$",
        description: "Provider slug, e.g. 'datura' or 'allways'.",
      },
      kind: {
        type: "string",
        enum: SURFACE_KINDS,
        description: "Filter by surface kind, e.g. 'subnet-api'.",
      },
      layer: {
        type: "string",
        enum: ENDPOINT_LAYERS,
        description: "Filter by endpoint layer.",
      },
      netuid: {
        type: "integer",
        description: "Filter to endpoints for one subnet netuid.",
        minimum: 0,
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
    required: ["slug"],
    additionalProperties: false,
  },
};

const NULLABLE_STRING = { type: ["string", "null"] };
const NULLABLE_INT = { type: ["integer", "null"] };

export const LIST_PROVIDER_ENDPOINTS_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: ["slug", "endpoints"],
  properties: {
    slug: { type: "string" },
    generated_at: NULLABLE_STRING,
    notes: {
      type: ["array", "string", "null"],
      items: { type: "string" },
    },
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
