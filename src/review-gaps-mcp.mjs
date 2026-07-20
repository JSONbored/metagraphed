// Review gap priorities list loader for MCP parity on GET /api/v1/review/gaps.
// Applies the same list-query transforms as the REST route over the baked
// /metagraph/review/gap-priorities.json artifact.

import { applyQueryFilters } from "../workers/list-query.mjs";
import { API_QUERY_COLLECTIONS, QUERY_ENUMS } from "./contracts.mjs";

export const REVIEW_GAPS_ARTIFACT = "/metagraph/review/gap-priorities.json";

const PRIORITY_SORT_FIELDS =
  API_QUERY_COLLECTIONS["review-gap-priorities"].sort_fields;
const CURATION_LEVELS = QUERY_ENUMS.curationLevel;
const SURFACE_KINDS = QUERY_ENUMS.surfaceKind;

export function reviewGapsMcpError(code, message) {
  const error = new Error(message);
  error.toolError = true;
  error.code = code;
  return error;
}

function optionalString(args, key) {
  const value = args?.[key];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim() === "") {
    throw reviewGapsMcpError(
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
    throw reviewGapsMcpError(
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

export function reviewGapsQueryUrl(args) {
  const url = new URL("https://mcp.internal/review/gaps");
  if (args?.netuid !== undefined) {
    if (!Number.isInteger(args.netuid) || args.netuid < 0) {
      throw reviewGapsMcpError(
        "invalid_params",
        "netuid must be a non-negative integer.",
      );
    }
    url.searchParams.set("netuid", String(args.netuid));
  }
  const curationLevel = optionalEnum(args, "curation_level", CURATION_LEVELS);
  if (curationLevel) url.searchParams.set("curation_level", curationLevel);
  const missingKinds = optionalEnum(args, "missing_kinds", SURFACE_KINDS);
  if (missingKinds) url.searchParams.set("missing_kinds", missingKinds);
  const reviewState = optionalString(args, "review_state");
  if (reviewState) url.searchParams.set("review_state", reviewState);
  const sort = optionalEnum(args, "sort", PRIORITY_SORT_FIELDS);
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
      throw reviewGapsMcpError(
        "invalid_params",
        "cursor must be a non-negative integer.",
      );
    }
    url.searchParams.set("cursor", String(args.cursor));
  }
  return url;
}

export async function loadReviewGapsList(ctx, args, { readArtifact } = {}) {
  const queryUrl = reviewGapsQueryUrl(args);
  const read = readArtifact ?? ctx.readArtifact;
  const result = await read(ctx.env, REVIEW_GAPS_ARTIFACT);
  if (!result?.ok) {
    const code = result?.code || "artifact_unavailable";
    if (code === "artifact_not_found") {
      throw reviewGapsMcpError(
        "not_found",
        "Review gap priorities snapshot unavailable.",
      );
    }
    throw reviewGapsMcpError(
      code,
      `Could not load ${REVIEW_GAPS_ARTIFACT} (${code}).`,
    );
  }
  const blob = result.data;
  if (!blob || typeof blob !== "object") {
    throw reviewGapsMcpError(
      "not_found",
      "Review gap priorities snapshot unavailable.",
    );
  }
  const transformed = applyQueryFilters(
    blob,
    queryUrl,
    "review-gap-priorities",
    [],
  );
  if (transformed.error) {
    throw reviewGapsMcpError("invalid_params", transformed.error.message);
  }
  const { data, meta } = transformed;
  const page = meta.pagination || {};
  const rows = Array.isArray(data.priorities) ? data.priorities : [];
  const rowLen = rows.length;
  return {
    generated_at: data.generated_at ?? null,
    notes: data.notes ?? null,
    priorities: rows,
    total: page.total ?? rowLen,
    returned: page.returned ?? rowLen,
    limit: page.limit ?? rowLen,
    cursor: page.cursor ?? 0,
    next_cursor: page.next_cursor ?? null,
    sort: page.sort ?? null,
    order: page.order ?? null,
  };
}

export const LIST_REVIEW_GAPS_INSTRUCTIONS =
  "list_review_gaps the contributor-targeted review gap priority board " +
  "(priority_score, missing kinds, and curation_level; mirrors GET /api/v1/review/gaps), ";

export const LIST_REVIEW_GAPS_MCP_TOOL = {
  name: "list_review_gaps",
  title: "List review gap priorities",
  description:
    "Fetch the contributor-targeted review gap priority board from the registry: " +
    "per-subnet priority_score, missing surface kinds, surface and candidate counts, " +
    "curation_level, and review_state. Filter by netuid, curation_level, missing_kinds, " +
    "or review_state; sort with sort + order; and page with limit (1-100) / cursor. " +
    "Distinct from list_gaps (interface facet reports at GET /api/v1/gaps) and " +
    "get_subnet_gaps (one subnet's detailed gap artifact). Mirrors GET /api/v1/review/gaps.",
  inputSchema: {
    type: "object",
    properties: {
      netuid: {
        type: "integer",
        description: "Filter to one subnet netuid.",
        minimum: 0,
      },
      curation_level: {
        type: "string",
        enum: CURATION_LEVELS,
        description: "Filter by curation level.",
      },
      missing_kinds: {
        type: "string",
        enum: SURFACE_KINDS,
        description: "Filter rows whose missing_kinds include this kind.",
      },
      review_state: {
        type: "string",
        description: "Filter by review_state substring match.",
      },
      sort: {
        type: "string",
        enum: PRIORITY_SORT_FIELDS,
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
          "Comma-separated projection of priority row fields to return.",
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

export const LIST_REVIEW_GAPS_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: ["priorities"],
  properties: {
    generated_at: NULLABLE_STRING,
    notes: {
      type: ["array", "string", "null"],
      items: { type: "string" },
    },
    priorities: { type: "array", items: { type: "object" } },
    total: { type: "integer" },
    returned: { type: "integer" },
    limit: { type: "integer" },
    cursor: { type: "integer" },
    next_cursor: NULLABLE_INT,
    sort: NULLABLE_STRING,
    order: NULLABLE_STRING,
  },
};
