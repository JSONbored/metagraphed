// Search list loader for MCP parity on GET /api/v1/search.
// Applies the same list-query transforms as the REST route over the baked
// /metagraph/search.json artifact (full documents WITH the per-document token
// blobs) — the same subnet/surface/provider corpus search_subnets reads but
// without its subnet-only filter, and unlike list_search_index it keeps tokens.

import { applyQueryFilters } from "../workers/list-query.ts";
import { API_QUERY_COLLECTIONS } from "./contracts.mjs";

export const SEARCH_ARTIFACT = "/metagraph/search.json";

const DOCUMENT_SORT_FIELDS = API_QUERY_COLLECTIONS.documents.sort_fields;

export function searchMcpError(code, message) {
  const error = new Error(message);
  error.toolError = true;
  error.code = code;
  return error;
}

function optionalString(args, key) {
  const value = args?.[key];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim() === "") {
    throw searchMcpError(
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
    throw searchMcpError(
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

export function searchQueryUrl(args) {
  const url = new URL("https://mcp.internal/search");
  const q = optionalString(args, "q");
  if (q) url.searchParams.set("q", q);
  const sort = optionalEnum(args, "sort", DOCUMENT_SORT_FIELDS);
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
      throw searchMcpError(
        "invalid_params",
        "cursor must be a non-negative integer.",
      );
    }
    url.searchParams.set("cursor", String(args.cursor));
  }
  return url;
}

export async function loadSearchList(ctx, args, { readArtifact } = {}) {
  const queryUrl = searchQueryUrl(args);
  const read = readArtifact ?? ctx.readArtifact;
  const result = await read(ctx.env, SEARCH_ARTIFACT);
  if (!result?.ok) {
    const code = result?.code || "artifact_unavailable";
    if (code === "artifact_not_found") {
      throw searchMcpError("not_found", "Search snapshot unavailable.");
    }
    throw searchMcpError(code, `Could not load ${SEARCH_ARTIFACT} (${code}).`);
  }
  const blob = result.data;
  if (!blob || typeof blob !== "object") {
    throw searchMcpError("not_found", "Search snapshot unavailable.");
  }
  const transformed = applyQueryFilters(blob, queryUrl, "documents", []);
  if (transformed.error) {
    throw searchMcpError("invalid_params", transformed.error.message);
  }
  const { data, meta } = transformed;
  const page = meta.pagination || {};
  const rows = Array.isArray(data.documents) ? data.documents : [];
  const rowLen = rows.length;
  return {
    generated_at: data.generated_at ?? null,
    notes: data.notes ?? null,
    documents: rows,
    total: page.total ?? rowLen,
    returned: page.returned ?? rowLen,
    limit: page.limit ?? rowLen,
    cursor: page.cursor ?? 0,
    next_cursor: page.next_cursor ?? null,
    sort: page.sort ?? null,
    order: page.order ?? null,
  };
}

export const LIST_SEARCH_INSTRUCTIONS =
  "Use list_search to keyword-search the full registry index across subnets, " +
  "surfaces, AND providers together (mirrors GET /api/v1/search), ";

export const LIST_SEARCH_MCP_TOOL = {
  name: "list_search",
  title: "List search documents",
  description:
    "Keyword-search the full registry search index: subnet, surface, and " +
    "provider documents with their per-document token blobs, mirroring " +
    "GET /api/v1/search. Filter with q, sort with sort + order, project with " +
    "fields, and page with limit (1-100) / cursor. Unlike search_subnets — which reads " +
    "the same artifact but only ever returns subnet hits — this spans all " +
    "three document types, so it works to find surfaces and providers even " +
    "when the AI layer semantic_search depends on is not configured. Unlike " +
    "list_search_index, which serves the slim variant without token blobs, this " +
    "keeps the full documents. Use semantic_search for meaning-based discovery.",
  inputSchema: {
    type: "object",
    properties: {
      q: {
        type: "string",
        description: "Keyword search across title, subtitle, slug, and tokens.",
      },
      sort: {
        type: "string",
        enum: DOCUMENT_SORT_FIELDS,
        description: "Field to sort by before paging.",
      },
      order: {
        type: "string",
        enum: ["asc", "desc"],
        description: "Sort direction for sort (default asc).",
      },
      fields: {
        type: "string",
        description: "Comma-separated projection of document fields to return.",
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

export const LIST_SEARCH_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: ["documents"],
  properties: {
    generated_at: NULLABLE_STRING,
    notes: {
      type: ["array", "string", "null"],
      items: { type: "string" },
    },
    documents: { type: "array", items: { type: "object" } },
    total: { type: "integer" },
    returned: { type: "integer" },
    limit: { type: "integer" },
    cursor: { type: "integer" },
    next_cursor: NULLABLE_INT,
    sort: NULLABLE_STRING,
    order: NULLABLE_STRING,
  },
};
