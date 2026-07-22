// Curated surfaces list loader for MCP parity on GET /api/v1/surfaces.
// Applies the same list-query transforms as the REST route over the baked
// /metagraph/surfaces.json artifact.

import { applyQueryFilters } from "../workers/list-query.ts";
import { API_QUERY_COLLECTIONS, QUERY_ENUMS } from "./contracts.mjs";

export const SURFACES_ARTIFACT = "/metagraph/surfaces.json";

const SURFACE_SORT_FIELDS =
  API_QUERY_COLLECTIONS["curated-surfaces"].sort_fields;
const SURFACE_KINDS = QUERY_ENUMS.surfaceKind;

export function surfacesMcpError(code, message) {
  const error = new Error(message);
  error.toolError = true;
  error.code = code;
  return error;
}

function optionalString(args, key) {
  const value = args?.[key];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim() === "") {
    throw surfacesMcpError(
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
    throw surfacesMcpError(
      "invalid_params",
      `Argument \`${key}\` must be one of: ${allowed.join(", ")}.`,
    );
  }
  return value;
}

export function surfacesQueryUrl(args) {
  const url = new URL("https://mcp.internal/surfaces");
  if (args?.netuid !== undefined) {
    if (!Number.isInteger(args.netuid) || args.netuid < 0) {
      throw surfacesMcpError(
        "invalid_params",
        "netuid must be a non-negative integer.",
      );
    }
    url.searchParams.set("netuid", String(args.netuid));
  }
  const kind = optionalEnum(args, "kind", SURFACE_KINDS);
  if (kind) url.searchParams.set("kind", kind);
  const provider = optionalString(args, "provider");
  if (provider) url.searchParams.set("provider", provider);
  const sort = optionalEnum(args, "sort", SURFACE_SORT_FIELDS);
  if (sort) url.searchParams.set("sort", sort);
  const order = optionalEnum(args, "order", ["asc", "desc"]);
  if (order) url.searchParams.set("order", order);
  const fields = optionalString(args, "fields");
  if (fields) url.searchParams.set("fields", fields);
  if (args?.limit !== undefined) {
    if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100) {
      throw surfacesMcpError(
        "invalid_params",
        "limit must be an integer between 1 and 100.",
      );
    }
    url.searchParams.set("limit", String(args.limit));
  }
  if (args?.cursor !== undefined) {
    if (!Number.isInteger(args.cursor) || args.cursor < 0) {
      throw surfacesMcpError(
        "invalid_params",
        "cursor must be a non-negative integer.",
      );
    }
    url.searchParams.set("cursor", String(args.cursor));
  }
  return url;
}

export async function loadSurfacesList(ctx, args, { readArtifact } = {}) {
  const queryUrl = surfacesQueryUrl(args);
  const read = readArtifact ?? ctx.readArtifact;
  const result = await read(ctx.env, SURFACES_ARTIFACT);
  if (!result?.ok) {
    const code = result?.code || "artifact_unavailable";
    if (code === "artifact_not_found") {
      throw surfacesMcpError(
        "not_found",
        "Curated surfaces catalog unavailable.",
      );
    }
    throw surfacesMcpError(
      code,
      `Could not load ${SURFACES_ARTIFACT} (${code}).`,
    );
  }
  const blob = result.data;
  if (!blob || typeof blob !== "object") {
    throw surfacesMcpError(
      "not_found",
      "Curated surfaces catalog unavailable.",
    );
  }
  const transformed = applyQueryFilters(blob, queryUrl, "curated-surfaces", []);
  if (transformed.error) {
    throw surfacesMcpError("invalid_params", transformed.error.message);
  }
  const { data, meta } = transformed;
  const page = meta.pagination || {};
  const rows = Array.isArray(data.surfaces) ? data.surfaces : [];
  const rowLen = rows.length;
  return {
    generated_at: data.generated_at ?? null,
    schema_version: data.schema_version ?? null,
    surfaces: rows,
    total: page.total ?? rowLen,
    returned: page.returned ?? rowLen,
    limit: page.limit ?? rowLen,
    cursor: page.cursor ?? 0,
    next_cursor: page.next_cursor ?? null,
    sort: page.sort ?? null,
    order: page.order ?? null,
  };
}

export const LIST_SURFACES_INSTRUCTIONS =
  "Use list_surfaces to page the network-wide curated public-surface catalog " +
  "with REST list-query filters (netuid, kind, provider, sort, and pagination; " +
  "mirrors GET /api/v1/surfaces), ";

export const LIST_SURFACES_MCP_TOOL = {
  name: "list_surfaces",
  title: "List curated public surfaces",
  description:
    "Fetch the catalog of curated public surfaces across all subnets: each " +
    "surface's subnet (netuid), kind, provider, title, url, and review state. " +
    "Filter by netuid, kind, or provider; sort with sort + order; project with " +
    "fields; and page with limit (1-100) / cursor. Distinct from " +
    "get_subnet_surfaces (one subnet's raw artifact dump). Mirrors " +
    "GET /api/v1/surfaces.",
  inputSchema: {
    type: "object",
    properties: {
      netuid: {
        type: "integer",
        description: "Filter by subnet netuid.",
        minimum: 0,
      },
      kind: {
        type: "string",
        enum: SURFACE_KINDS,
        description: "Surface kind, e.g. 'openapi' or 'subnet-api'.",
      },
      provider: {
        type: "string",
        description: "Provider slug, e.g. 'datura'.",
      },
      sort: {
        type: "string",
        enum: SURFACE_SORT_FIELDS,
        description: "Field to sort by before paging.",
      },
      order: {
        type: "string",
        enum: ["asc", "desc"],
        description: "Sort direction for sort (default asc).",
      },
      fields: {
        type: "string",
        description: "Comma-separated projection of surface fields to return.",
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

export const LIST_SURFACES_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: ["surfaces"],
  properties: {
    generated_at: NULLABLE_STRING,
    schema_version: { type: ["string", "integer", "null"] },
    surfaces: { type: "array", items: { type: "object" } },
    total: { type: "integer" },
    returned: { type: "integer" },
    limit: { type: "integer" },
    cursor: { type: "integer" },
    next_cursor: NULLABLE_INT,
    sort: NULLABLE_STRING,
    order: NULLABLE_STRING,
  },
};
