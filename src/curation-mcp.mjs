// Curation list loader for MCP parity on GET /api/v1/curation.
// Applies the same list-query transforms as the REST route over the baked
// /metagraph/curation.json artifact.

import { applyQueryFilters } from "../workers/list-query.ts";
import { API_QUERY_COLLECTIONS, QUERY_ENUMS } from "./contracts.mjs";

export const CURATION_ARTIFACT = "/metagraph/curation.json";

const CURATION_SORT_FIELDS = API_QUERY_COLLECTIONS.curation.sort_fields;
const COVERAGE_LEVELS = QUERY_ENUMS.coverageLevel;

export function curationMcpError(code, message) {
  const error = new Error(message);
  error.toolError = true;
  error.code = code;
  return error;
}

function optionalString(args, key) {
  const value = args?.[key];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim() === "") {
    throw curationMcpError(
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
    throw curationMcpError(
      "invalid_params",
      `Argument \`${key}\` must be one of: ${allowed.join(", ")}.`,
    );
  }
  return value;
}

export function curationQueryUrl(args) {
  const url = new URL("https://mcp.internal/curation");
  if (args?.netuid !== undefined) {
    if (!Number.isInteger(args.netuid) || args.netuid < 0) {
      throw curationMcpError(
        "invalid_params",
        "netuid must be a non-negative integer.",
      );
    }
    url.searchParams.set("netuid", String(args.netuid));
  }
  const coverageLevel = optionalEnum(args, "coverage_level", COVERAGE_LEVELS);
  if (coverageLevel) {
    url.searchParams.set("coverage_level", coverageLevel);
  }
  const sort = optionalEnum(args, "sort", CURATION_SORT_FIELDS);
  if (sort) url.searchParams.set("sort", sort);
  const order = optionalEnum(args, "order", ["asc", "desc"]);
  if (order) url.searchParams.set("order", order);
  const fields = optionalString(args, "fields");
  if (fields) url.searchParams.set("fields", fields);
  if (args?.limit !== undefined) {
    if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100) {
      throw curationMcpError(
        "invalid_params",
        "limit must be an integer between 1 and 100.",
      );
    }
    url.searchParams.set("limit", String(args.limit));
  }
  if (args?.cursor !== undefined) {
    if (!Number.isInteger(args.cursor) || args.cursor < 0) {
      throw curationMcpError(
        "invalid_params",
        "cursor must be a non-negative integer.",
      );
    }
    url.searchParams.set("cursor", String(args.cursor));
  }
  return url;
}

export async function loadCurationList(ctx, args, { readArtifact } = {}) {
  const queryUrl = curationQueryUrl(args);
  const read = readArtifact ?? ctx.readArtifact;
  const result = await read(ctx.env, CURATION_ARTIFACT);
  if (!result?.ok) {
    const code = result?.code || "artifact_unavailable";
    if (code === "artifact_not_found") {
      throw curationMcpError("not_found", "Curation snapshot unavailable.");
    }
    throw curationMcpError(
      code,
      `Could not load ${CURATION_ARTIFACT} (${code}).`,
    );
  }
  const blob = result.data;
  if (!blob || typeof blob !== "object") {
    throw curationMcpError("not_found", "Curation snapshot unavailable.");
  }
  const transformed = applyQueryFilters(blob, queryUrl, "curation", []);
  if (transformed.error) {
    throw curationMcpError("invalid_params", transformed.error.message);
  }
  const { data, meta } = transformed;
  const page = meta.pagination || {};
  const rows = Array.isArray(data.curation) ? data.curation : [];
  const rowLen = rows.length;
  return {
    generated_at: data.generated_at ?? null,
    notes: data.notes ?? null,
    curation: rows,
    total: page.total ?? rowLen,
    returned: page.returned ?? rowLen,
    limit: page.limit ?? rowLen,
    cursor: page.cursor ?? 0,
    next_cursor: page.next_cursor ?? null,
    sort: page.sort ?? null,
    order: page.order ?? null,
  };
}

export const LIST_CURATION_INSTRUCTIONS =
  "list_curation per-subnet curation states (coverage_level, curation_level, " +
  "source counts; mirrors GET /api/v1/curation), ";

export const LIST_CURATION_MCP_TOOL = {
  name: "list_curation",
  title: "List subnet curation states",
  description:
    "Fetch per-subnet curation states from the registry: coverage_level, " +
    "curation_level, source counts, and review posture for every active subnet. " +
    "Filter by netuid or coverage_level, sort with sort + order, and page with " +
    "limit (1-100) / cursor. Mirrors GET /api/v1/curation.",
  inputSchema: {
    type: "object",
    properties: {
      netuid: {
        type: "integer",
        description: "Filter to one subnet netuid.",
        minimum: 0,
      },
      coverage_level: {
        type: "string",
        enum: COVERAGE_LEVELS,
        description:
          "Filter by coverage depth: native-only, manifested, or probed.",
      },
      sort: {
        type: "string",
        enum: CURATION_SORT_FIELDS,
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
          "Comma-separated projection of curation row fields to return.",
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

export const LIST_CURATION_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: ["curation"],
  properties: {
    generated_at: NULLABLE_STRING,
    notes: NULLABLE_STRING,
    curation: { type: "array", items: { type: "object" } },
    total: { type: "integer" },
    returned: { type: "integer" },
    limit: { type: "integer" },
    cursor: { type: "integer" },
    next_cursor: NULLABLE_INT,
    sort: NULLABLE_STRING,
    order: NULLABLE_STRING,
  },
};
