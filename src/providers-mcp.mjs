// Providers list loader for MCP parity on GET /api/v1/providers.
// Applies the same list-query transforms as the REST route over the baked
// /metagraph/providers.json artifact.

import { applyQueryFilters } from "../workers/list-query.mjs";
import { API_QUERY_COLLECTIONS, QUERY_ENUMS } from "./contracts.mjs";

export const PROVIDERS_ARTIFACT = "/metagraph/providers.json";

const PROVIDER_SORT_FIELDS = API_QUERY_COLLECTIONS.providers.sort_fields;
const PROVIDER_KINDS = QUERY_ENUMS.providerKind;
const PROVIDER_AUTHORITIES = QUERY_ENUMS.providerAuthority;

export function providersMcpError(code, message) {
  const error = new Error(message);
  error.toolError = true;
  error.code = code;
  return error;
}

function optionalString(args, key) {
  const value = args?.[key];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim() === "") {
    throw providersMcpError(
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
    throw providersMcpError(
      "invalid_params",
      `Argument \`${key}\` must be one of: ${allowed.join(", ")}.`,
    );
  }
  return value;
}

function clampLimit(value, fallback, max) {
  if (typeof value !== "number") return fallback;
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.min(max, Math.floor(value));
}

export function providersQueryUrl(args) {
  const url = new URL("https://mcp.internal/providers");
  const id = optionalString(args, "id");
  if (id) url.searchParams.set("id", id);
  const kind = optionalEnum(args, "kind", PROVIDER_KINDS);
  if (kind) url.searchParams.set("kind", kind);
  const authority = optionalEnum(args, "authority", PROVIDER_AUTHORITIES);
  if (authority) url.searchParams.set("authority", authority);
  const sort = optionalEnum(args, "sort", PROVIDER_SORT_FIELDS);
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
      throw providersMcpError(
        "invalid_params",
        "cursor must be a non-negative integer.",
      );
    }
    url.searchParams.set("cursor", String(args.cursor));
  }
  return url;
}

export async function loadProvidersList(ctx, args, { readArtifact } = {}) {
  const queryUrl = providersQueryUrl(args);
  const read = readArtifact ?? ctx.readArtifact;
  const result = await read(ctx.env, PROVIDERS_ARTIFACT);
  if (!result?.ok) {
    const code = result?.code || "artifact_unavailable";
    if (code === "artifact_not_found") {
      throw providersMcpError("not_found", "Providers index unavailable.");
    }
    throw providersMcpError(
      code,
      `Could not load ${PROVIDERS_ARTIFACT} (${code}).`,
    );
  }
  const blob = result.data;
  if (!blob || typeof blob !== "object") {
    throw providersMcpError("not_found", "Providers index unavailable.");
  }
  const transformed = applyQueryFilters(blob, queryUrl, "providers", []);
  if (transformed.error) {
    throw providersMcpError("invalid_params", transformed.error.message);
  }
  const { data, meta } = transformed;
  const page = meta.pagination || {};
  const rows = Array.isArray(data.providers) ? data.providers : [];
  const rowLen = rows.length;
  return {
    generated_at: data.generated_at ?? null,
    schema_version: data.schema_version ?? null,
    providers: rows,
    total: page.total ?? rowLen,
    returned: page.returned ?? rowLen,
    limit: page.limit ?? rowLen,
    cursor: page.cursor ?? 0,
    next_cursor: page.next_cursor ?? null,
    sort: page.sort ?? null,
    order: page.order ?? null,
  };
}

export const LIST_PROVIDERS_INSTRUCTIONS =
  "Use list_providers to page the provider/source index with REST list-query " +
  "filters (id, kind, authority, sort, and pagination; mirrors GET /api/v1/providers), ";

export const LIST_PROVIDERS_MCP_TOOL = {
  name: "list_providers",
  title: "List providers and sources",
  description:
    "Fetch the index of registered data providers/sources backing the registry: " +
    "each provider's id, kind, authority, name, and the subnets, surfaces, and " +
    "endpoints it backs. Filter by id, kind, or authority; sort with sort + order; " +
    "project with fields; and page with limit (1-100) / cursor. This is the list " +
    "counterpart to get_provider_detail (one provider by slug). Mirrors " +
    "GET /api/v1/providers.",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "Provider slug, e.g. 'datura'.",
      },
      kind: {
        type: "string",
        enum: PROVIDER_KINDS,
        description: "Provider kind, e.g. 'data-provider' or 'registry'.",
      },
      authority: {
        type: "string",
        enum: PROVIDER_AUTHORITIES,
        description: "Trust authority, e.g. 'official' or 'community'.",
      },
      sort: {
        type: "string",
        enum: PROVIDER_SORT_FIELDS,
        description: "Field to sort by before paging.",
      },
      order: {
        type: "string",
        enum: ["asc", "desc"],
        description: "Sort direction for sort (default asc).",
      },
      fields: {
        type: "string",
        description: "Comma-separated projection of provider fields to return.",
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

export const LIST_PROVIDERS_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: ["providers"],
  properties: {
    generated_at: NULLABLE_STRING,
    schema_version: { type: ["string", "integer", "null"] },
    providers: { type: "array", items: { type: "object" } },
    total: { type: "integer" },
    returned: { type: "integer" },
    limit: { type: "integer" },
    cursor: { type: "integer" },
    next_cursor: NULLABLE_INT,
    sort: NULLABLE_STRING,
    order: NULLABLE_STRING,
  },
};
