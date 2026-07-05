// Per-subnet curated surfaces list loader for MCP parity on
// GET /api/v1/subnets/{netuid}/surfaces. Applies the same list-query
// transforms as the REST route over the baked
// /metagraph/surfaces/{netuid}.json artifact.

import { applyQueryFilters } from "../workers/list-query.mjs";
import { API_QUERY_COLLECTIONS, QUERY_ENUMS } from "./contracts.mjs";

const SURFACE_SORT_FIELDS =
  API_QUERY_COLLECTIONS["curated-surfaces"].sort_fields;
const SURFACE_KINDS = QUERY_ENUMS.surfaceKind;
const SUBNET_SURFACES_QUERY_FILTER_NAMES = ["kind", "provider"];

export function subnetSurfacesArtifactPath(netuid) {
  return `/metagraph/surfaces/${netuid}.json`;
}

export function subnetSurfacesMcpError(code, message) {
  const error = new Error(message);
  error.toolError = true;
  error.code = code;
  return error;
}

function requireNetuid(args) {
  const netuid = args?.netuid;
  if (!Number.isInteger(netuid) || netuid < 0) {
    throw subnetSurfacesMcpError(
      "invalid_params",
      "netuid must be a non-negative integer.",
    );
  }
  return netuid;
}

function optionalString(args, key) {
  const value = args?.[key];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim() === "") {
    throw subnetSurfacesMcpError(
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
    throw subnetSurfacesMcpError(
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

export function subnetSurfacesQueryUrl(args) {
  const url = new URL("https://mcp.internal/subnets/surfaces");
  requireNetuid(args);
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
    url.searchParams.set("limit", String(clampLimit(args.limit, 50, 100)));
  }
  if (args?.cursor !== undefined) {
    if (!Number.isInteger(args.cursor) || args.cursor < 0) {
      throw subnetSurfacesMcpError(
        "invalid_params",
        "cursor must be a non-negative integer.",
      );
    }
    url.searchParams.set("cursor", String(args.cursor));
  }
  return url;
}

export async function loadSubnetSurfacesList(ctx, args, { readArtifact } = {}) {
  const netuid = requireNetuid(args);
  const queryUrl = subnetSurfacesQueryUrl(args);
  const artifactPath = subnetSurfacesArtifactPath(netuid);
  const read = readArtifact ?? ctx.readArtifact;
  const result = await read(ctx.env, artifactPath);
  if (!result?.ok) {
    const code = result?.code || "artifact_unavailable";
    if (code === "artifact_not_found") {
      throw subnetSurfacesMcpError(
        "not_found",
        `No curated surfaces snapshot exists for netuid ${netuid}.`,
      );
    }
    throw subnetSurfacesMcpError(
      code,
      `Could not load ${artifactPath} (${code}).`,
    );
  }
  const blob = result.data;
  if (!blob || typeof blob !== "object") {
    throw subnetSurfacesMcpError(
      "not_found",
      `No curated surfaces snapshot exists for netuid ${netuid}.`,
    );
  }
  const transformed = applyQueryFilters(
    blob,
    queryUrl,
    "curated-surfaces",
    SUBNET_SURFACES_QUERY_FILTER_NAMES,
  );
  if (transformed.error) {
    throw subnetSurfacesMcpError("invalid_params", transformed.error.message);
  }
  const { data, meta } = transformed;
  const page = meta.pagination || {};
  const rows = Array.isArray(data.surfaces) ? data.surfaces : [];
  const rowLen = rows.length;
  return {
    generated_at: data.generated_at ?? null,
    netuid: data.netuid ?? netuid,
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

export const LIST_SUBNET_SURFACES_INSTRUCTIONS =
  "list_subnet_surfaces one subnet's curated public surfaces with REST list-query " +
  "filters (kind, provider, sort, and pagination; mirrors " +
  "GET /api/v1/subnets/{netuid}/surfaces), ";

export const LIST_SUBNET_SURFACES_MCP_TOOL = {
  name: "list_subnet_surfaces",
  title: "List one subnet's curated surfaces",
  description:
    "Fetch the curated public surfaces for one subnet by netuid: each surface's " +
    "kind, provider, title, url, and review state. Filter by kind or provider; " +
    "sort with sort + order; and page with limit (1-100) / cursor. Distinct from " +
    "list_surfaces (network-wide catalog) and get_subnet (full subnet detail bundle). " +
    "Mirrors GET /api/v1/subnets/{netuid}/surfaces.",
  inputSchema: {
    type: "object",
    properties: {
      netuid: {
        type: "integer",
        description: "Subnet netuid.",
        minimum: 0,
      },
      kind: {
        type: "string",
        enum: SURFACE_KINDS,
        description: "Filter by surface kind, e.g. 'openapi' or 'subnet-api'.",
      },
      provider: {
        type: "string",
        description: "Filter by provider slug, e.g. 'datura'.",
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
        description:
          "Comma-separated projection of surface row fields to return.",
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
    required: ["netuid"],
    additionalProperties: false,
  },
};

const NULLABLE_STRING = { type: ["string", "null"] };
const NULLABLE_INT = { type: ["integer", "null"] };

export const LIST_SUBNET_SURFACES_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: ["surfaces"],
  properties: {
    generated_at: NULLABLE_STRING,
    netuid: NULLABLE_INT,
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
