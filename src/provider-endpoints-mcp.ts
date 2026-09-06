// Provider endpoint list loader for MCP parity on
// GET /api/v1/providers/{slug}/endpoints. Applies the same list-query
// transforms as the REST route over the baked
// /metagraph/providers/{slug}/endpoints.json artifact.

import { clampToolLimit } from "../workers/request-params.ts";
import { PROVIDER_ENDPOINTS_LIMIT_DEFAULT } from "./route-limits.ts";
import { applyMcpQueryFilters, type Row } from "./mcp-list-query.ts";
import type { StorageReadResult } from "../workers/storage.ts";
import { API_QUERY_COLLECTIONS, QUERY_ENUMS } from "./contracts.ts";
import {
  ListProviderEndpointsInputSchema,
  ListProviderEndpointsOutputSchema,
} from "../schemas-src/mcp-tools/endpoint-pools-and-provider.ts";
import { inputJsonSchema, outputJsonSchema } from "./mcp-input-schema.ts";
import {
  overlayArtifactEndpoints,
  resolveLiveHealth,
} from "./health-serving.ts";

export const PROVIDER_SLUG_PATTERN = /^[a-z0-9-]+$/;

const ENDPOINT_SORT_FIELDS = API_QUERY_COLLECTIONS.endpoints.sort_fields;
const SURFACE_KINDS = QUERY_ENUMS.surfaceKind;
const ENDPOINT_LAYERS = QUERY_ENUMS.endpointLayer;
const HEALTH_STATUSES = QUERY_ENUMS.healthStatus;
const PUBLICATION_STATES = QUERY_ENUMS.endpointPublicationState;

export function providerEndpointsArtifactPath(slug: string): string {
  return `/metagraph/providers/${slug}/endpoints.json`;
}

export interface ProviderEndpointsMcpError extends Error {
  toolError: true;
  code: string;
}

export function providerEndpointsMcpError(
  code: string,
  message: string,
): ProviderEndpointsMcpError {
  const error = new Error(message) as ProviderEndpointsMcpError;
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
    throw providerEndpointsMcpError(
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
    throw providerEndpointsMcpError(
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
    throw providerEndpointsMcpError(
      "invalid_params",
      `Argument \`${key}\` must be a finite number when provided.`,
    );
  }
  return value;
}

export function parseProviderSlug(
  args: Record<string, unknown> | null | undefined,
): string {
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

export function providerEndpointsQueryUrl(
  args: Record<string, unknown> | null | undefined,
): URL {
  const url = new URL("https://mcp.internal/provider-endpoints");
  if (args?.netuid !== undefined) {
    const netuid = args.netuid;
    if (typeof netuid !== "number" || !Number.isInteger(netuid) || netuid < 0) {
      throw providerEndpointsMcpError(
        "invalid_params",
        "netuid must be a non-negative integer.",
      );
    }
    url.searchParams.set("netuid", String(netuid));
  }
  const q = ListProviderEndpointsInputSchema.shape.q.safeParse(args?.q);
  if (!q.success) {
    throw providerEndpointsMcpError(
      "invalid_params",
      q.error.issues[0].message,
    );
  }
  if (q.data !== undefined) url.searchParams.set("q", q.data);
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
  for (const key of ["pool_eligible", "known_status"]) {
    if (args?.[key] === undefined) continue;
    if (key === "known_status" && args[key] === null) continue;
    if (typeof args[key] !== "boolean") {
      throw providerEndpointsMcpError(
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
    url.searchParams.set(
      "limit",
      String(clampToolLimit(args.limit, PROVIDER_ENDPOINTS_LIMIT_DEFAULT, 100)),
    );
  }
  if (args?.cursor !== undefined) {
    const cursor = args.cursor;
    if (typeof cursor !== "number" || !Number.isInteger(cursor) || cursor < 0) {
      throw providerEndpointsMcpError(
        "invalid_params",
        "cursor must be a non-negative integer.",
      );
    }
    url.searchParams.set("cursor", String(cursor));
  }
  return url;
}

export interface ProviderEndpointsListResult {
  slug: string;
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

export async function loadProviderEndpointsList(
  ctx: {
    env: Env;
    readArtifact: (env: Env, path: string) => Promise<StorageReadResult>;
    readHealthKv?: (env: Env, key: string) => Promise<unknown>;
  },
  args: Record<string, unknown> | null | undefined,
  {
    readArtifact,
    loadHealth,
  }: {
    readArtifact?: (env: Env, path: string) => Promise<StorageReadResult>;
    // GraphQL shares its existing request-memoized health resolution.
    loadHealth?: () => ReturnType<typeof resolveLiveHealth>;
  } = {},
): Promise<ProviderEndpointsListResult> {
  const slug = parseProviderSlug(args);
  const queryUrl = providerEndpointsQueryUrl(args);
  const artifactPath = providerEndpointsArtifactPath(slug);
  const read = readArtifact ?? ctx.readArtifact;
  const result = await read(ctx.env, artifactPath);
  if (!result?.ok) {
    const code =
      (result as { code?: string } | undefined)?.code || "artifact_unavailable";
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
  let dataToFilter = blob as Record<string, unknown>;
  // Match the generalized REST/inline MCP overlay before status filtering.
  // Legacy rows without surface identities retain their existing behavior.
  if (
    Array.isArray(dataToFilter.endpoints) &&
    dataToFilter.endpoints.some((endpoint: Row) => endpoint?.surface_id)
  ) {
    dataToFilter = overlayArtifactEndpoints(
      dataToFilter,
      await (loadHealth ? loadHealth() : resolveLiveHealth(ctx)),
    )!;
  }
  const transformed = applyMcpQueryFilters(
    dataToFilter,
    queryUrl,
    "endpoints",
    [],
  );
  if (transformed.error) {
    throw providerEndpointsMcpError(
      "invalid_params",
      transformed.error.message,
    );
  }
  const data = transformed.data as Record<string, unknown>;
  const meta = transformed.meta as Record<string, unknown>;
  const page = (meta.pagination as Record<string, unknown>) || {};
  const rows = Array.isArray(data.endpoints) ? (data.endpoints as Row[]) : [];
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
    "Fetch endpoint resources for one provider by slug: each " +
    "endpoint/surface with its kind, layer, subnet (netuid), publication state, " +
    "and probe-derived status/latency/score. Filter by kind/layer/netuid/" +
    "publication_state/status/known_status/pool_eligible, threshold with min_/max_latency_ms " +
    "and min_/max_score, sort with sort + order, and page with limit (1-100) / " +
    "cursor. The per-provider view of list_endpoints (the network-wide catalog). " +
    "Complements get_provider_detail (identity + optional endpoints attachment). " +
    "Mirrors GET /api/v1/providers/{slug}/endpoints.",
  inputSchema: inputJsonSchema(ListProviderEndpointsInputSchema),
};

export const LIST_PROVIDER_ENDPOINTS_OUTPUT_SCHEMA = outputJsonSchema(
  ListProviderEndpointsOutputSchema,
);
