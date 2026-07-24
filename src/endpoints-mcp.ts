// Network-wide endpoint list loader for MCP parity on GET /api/v1/endpoints.
// Applies the same list-query transforms as the REST route over the baked
// /metagraph/endpoints.json artifact, with a live health overlay via
// overlayArtifactEndpoints before filtering so status/latency filters read
// current probe-derived values. Structurally mirrors provider-endpoints-mcp.ts
// and subnet-endpoints-mcp.ts, adding sort/order/fields via applyQueryFilters.

import { applyQueryFilters, type Row } from "../workers/list-query.ts";
import type { StorageReadResult } from "../workers/storage.ts";
import { API_QUERY_COLLECTIONS, QUERY_ENUMS } from "./contracts.ts";
import {
  overlayArtifactEndpoints,
  resolveLiveHealth,
} from "./health-serving.ts";

export const ENDPOINTS_ARTIFACT = "/metagraph/endpoints.json";

const ENDPOINT_SORT_FIELDS = API_QUERY_COLLECTIONS.endpoints.sort_fields;
const SURFACE_KINDS = QUERY_ENUMS.surfaceKind;
const ENDPOINT_LAYERS = QUERY_ENUMS.endpointLayer;
const PUBLICATION_STATES = QUERY_ENUMS.endpointPublicationState;
const HEALTH_STATUSES = QUERY_ENUMS.healthStatus;

export interface EndpointsMcpError extends Error {
  toolError: true;
  code: string;
}

export function endpointsMcpError(
  code: string,
  message: string,
): EndpointsMcpError {
  const error = new Error(message) as EndpointsMcpError;
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
    throw endpointsMcpError(
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
    throw endpointsMcpError(
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
    throw endpointsMcpError(
      "invalid_params",
      `Argument \`${key}\` must be a finite number when provided.`,
    );
  }
  return value;
}

function clampLimit(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number") return fallback;
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.min(max, Math.floor(value));
}

export function endpointsQueryUrl(
  args: Record<string, unknown> | null | undefined,
): URL {
  const url = new URL("https://mcp.internal/endpoints");
  const kind = optionalEnum(args, "kind", SURFACE_KINDS);
  if (kind) url.searchParams.set("kind", kind);
  const layer = optionalEnum(args, "layer", ENDPOINT_LAYERS);
  if (layer) url.searchParams.set("layer", layer);
  if (args?.netuid !== undefined) {
    if (
      typeof args.netuid !== "number" ||
      !Number.isInteger(args.netuid) ||
      (args.netuid as number) < 0
    ) {
      throw endpointsMcpError(
        "invalid_params",
        "netuid must be a non-negative integer.",
      );
    }
    url.searchParams.set("netuid", String(args.netuid));
  }
  if (args?.pool_eligible !== undefined) {
    if (typeof args.pool_eligible !== "boolean") {
      throw endpointsMcpError(
        "invalid_params",
        "pool_eligible must be a boolean when provided.",
      );
    }
    url.searchParams.set("pool_eligible", String(args.pool_eligible));
  }
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
  const minLatencyMs = optionalRangeBound(args, "min_latency_ms");
  if (minLatencyMs !== null) {
    url.searchParams.set("min_latency_ms", String(minLatencyMs));
  }
  const maxLatencyMs = optionalRangeBound(args, "max_latency_ms");
  if (maxLatencyMs !== null) {
    url.searchParams.set("max_latency_ms", String(maxLatencyMs));
  }
  const minScore = optionalRangeBound(args, "min_score");
  if (minScore !== null) url.searchParams.set("min_score", String(minScore));
  const maxScore = optionalRangeBound(args, "max_score");
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
    const cursor = args.cursor;
    if (typeof cursor !== "number" || !Number.isInteger(cursor) || cursor < 0) {
      throw endpointsMcpError(
        "invalid_params",
        "cursor must be a non-negative integer.",
      );
    }
    url.searchParams.set("cursor", String(cursor));
  }
  return url;
}

interface EndpointsMcpCtx {
  env: Env;
  readArtifact: (env: Env, path: string) => Promise<StorageReadResult>;
  readHealthKv?: (
    env: Env,
    key: string,
  ) => Promise<Record<string, unknown> | null>;
}

export interface EndpointsListResult {
  generated_at: unknown;
  notes: unknown;
  endpoints: Row[];
  total: unknown;
  returned: unknown;
  limit: unknown;
  cursor: unknown;
  next_cursor: unknown;
  sort: unknown;
  order: unknown;
}

export async function loadEndpointsList(
  ctx: EndpointsMcpCtx,
  args: Record<string, unknown> | null | undefined,
  {
    readArtifact,
  }: {
    readArtifact?: (env: Env, path: string) => Promise<StorageReadResult>;
  } = {},
): Promise<EndpointsListResult> {
  const queryUrl = endpointsQueryUrl(args);
  const read = readArtifact ?? ctx.readArtifact;
  const result = await read(ctx.env, ENDPOINTS_ARTIFACT);
  if (!result?.ok) {
    const code =
      (result as { code?: string } | undefined)?.code || "artifact_unavailable";
    if (code === "artifact_not_found") {
      throw endpointsMcpError("not_found", "Endpoint catalog unavailable.");
    }
    throw endpointsMcpError(
      code,
      `Could not load ${ENDPOINTS_ARTIFACT} (${code}).`,
    );
  }
  const blob = result.data;
  if (!blob || typeof blob !== "object") {
    throw endpointsMcpError("not_found", "Endpoint catalog unavailable.");
  }

  // Live health overlay — same guard as the REST route: only apply when the
  // artifact carries surface_id references (i.e. it was built with live-
  // endpoint health plumbing). This prevents spurious overlay misses on older
  // artifact shapes. Applied before applyQueryFilters so status/latency
  // filters read current probe-derived values, not stale baked ones.
  let overlaid = blob as Record<string, unknown>;
  if (
    Array.isArray(overlaid.endpoints) &&
    (overlaid.endpoints as Row[]).some((e) => e?.surface_id)
  ) {
    const live = await resolveLiveHealth({
      readHealthKv: ctx.readHealthKv,
      env: ctx.env,
    });
    const merged = overlayArtifactEndpoints(overlaid, live);
    if (merged) overlaid = merged as Record<string, unknown>;
  }

  const transformed = applyQueryFilters(overlaid, queryUrl, "endpoints", []);
  if (transformed.error) {
    throw endpointsMcpError("invalid_params", transformed.error.message);
  }
  const data = transformed.data as Record<string, unknown>;
  const meta = transformed.meta as Record<string, unknown>;
  const page = (meta.pagination as Record<string, unknown>) || {};
  const rows = Array.isArray(data.endpoints) ? (data.endpoints as Row[]) : [];
  const rowLen = rows.length;
  return {
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

export const LIST_ENDPOINTS_INSTRUCTIONS =
  "list_endpoints the network-wide monitored endpoint catalog with REST list-" +
  "query filters (kind, layer, netuid, pool_eligible, provider, " +
  "publication_state, status, latency/score bounds, sort, order, fields, and " +
  "pagination; mirrors GET /api/v1/endpoints), ";

export const LIST_ENDPOINTS_MCP_TOOL = {
  name: "list_endpoints",
  title: "List monitored endpoint resources",
  description:
    "Fetch the network-wide catalog of generalized endpoint resources: every " +
    "monitored public endpoint/surface across providers and subnets, each " +
    "with its kind, layer, provider, subnet (netuid), publication state, and " +
    "probe-derived status/latency/score. Filter by kind, layer, netuid, " +
    "pool_eligible, provider, publication_state, or status; bound by " +
    "min_/max_latency_ms and min_/max_score; sort with sort + order; project " +
    "with fields; and page with limit (1-100) / cursor. Mirrors " +
    "GET /api/v1/endpoints.",
  inputSchema: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: SURFACE_KINDS,
        description: "Surface kind, e.g. 'subnet-api' or 'openapi'.",
      },
      layer: {
        type: "string",
        enum: ENDPOINT_LAYERS,
        description: "Endpoint layer, e.g. 'subnet-app' or 'bittensor-base'.",
      },
      netuid: {
        type: "integer",
        description: "Filter by subnet netuid.",
        minimum: 0,
      },
      pool_eligible: {
        type: "boolean",
        description: "Only endpoints eligible (or not) for RPC pooling.",
      },
      provider: {
        type: "string",
        description: "Provider slug, e.g. 'datura'.",
      },
      publication_state: {
        type: "string",
        enum: PUBLICATION_STATES,
        description: "Publication state, e.g. 'monitored' or 'pool-eligible'.",
      },
      status: {
        type: "string",
        enum: HEALTH_STATUSES,
        description: "Probe-derived health status, e.g. 'ok' or 'degraded'.",
      },
      min_latency_ms: {
        type: "number",
        description: "Only endpoints with probe-derived latency_ms >= this.",
      },
      max_latency_ms: {
        type: "number",
        description: "Only endpoints with probe-derived latency_ms <= this.",
      },
      min_score: {
        type: "number",
        description: "Only endpoints with probe-derived score >= this.",
      },
      max_score: {
        type: "number",
        description: "Only endpoints with probe-derived score <= this.",
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
        description:
          "Pagination cursor from a prior response's next_cursor. Default 0.",
        minimum: 0,
      },
    },
    additionalProperties: false,
  },
};

const NULLABLE_STRING = { type: ["string", "null"] };
const NULLABLE_INT = { type: ["integer", "null"] };

export const LIST_ENDPOINTS_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: ["endpoints"],
  properties: {
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
