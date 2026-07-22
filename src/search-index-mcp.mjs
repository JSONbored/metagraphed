// Search index list loader for MCP parity on GET /api/v1/search-index.
// Applies the same list-query transforms as the REST route over the baked
// /metagraph/search-index.json artifact (slim documents without token blobs).

import { applyQueryFilters } from "../workers/list-query.ts";
import { API_QUERY_COLLECTIONS } from "./contracts.mjs";

export const SEARCH_INDEX_ARTIFACT = "/metagraph/search-index.json";

const DOCUMENT_SORT_FIELDS = API_QUERY_COLLECTIONS.documents.sort_fields;

export function searchIndexMcpError(code, message) {
  const error = new Error(message);
  error.toolError = true;
  error.code = code;
  return error;
}

function optionalString(args, key) {
  const value = args?.[key];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim() === "") {
    throw searchIndexMcpError(
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
    throw searchIndexMcpError(
      "invalid_params",
      `Argument \`${key}\` must be one of: ${allowed.join(", ")}.`,
    );
  }
  return value;
}

export function searchIndexQueryUrl(args) {
  const url = new URL("https://mcp.internal/search-index");
  const q = optionalString(args, "q");
  if (q) url.searchParams.set("q", q);
  const sort = optionalEnum(args, "sort", DOCUMENT_SORT_FIELDS);
  if (sort) url.searchParams.set("sort", sort);
  const order = optionalEnum(args, "order", ["asc", "desc"]);
  if (order) url.searchParams.set("order", order);
  const fields = optionalString(args, "fields");
  if (fields) url.searchParams.set("fields", fields);
  if (args?.limit !== undefined) {
    if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100) {
      throw searchIndexMcpError(
        "invalid_params",
        "limit must be an integer between 1 and 100.",
      );
    }
    url.searchParams.set("limit", String(args.limit));
  }
  if (args?.cursor !== undefined) {
    if (!Number.isInteger(args.cursor) || args.cursor < 0) {
      throw searchIndexMcpError(
        "invalid_params",
        "cursor must be a non-negative integer.",
      );
    }
    url.searchParams.set("cursor", String(args.cursor));
  }
  return url;
}

export async function loadSearchIndexList(ctx, args, { readArtifact } = {}) {
  const queryUrl = searchIndexQueryUrl(args);
  const read = readArtifact ?? ctx.readArtifact;
  const result = await read(ctx.env, SEARCH_INDEX_ARTIFACT);
  if (!result?.ok) {
    const code = result?.code || "artifact_unavailable";
    if (code === "artifact_not_found") {
      throw searchIndexMcpError(
        "not_found",
        "Search index snapshot unavailable.",
      );
    }
    throw searchIndexMcpError(
      code,
      `Could not load ${SEARCH_INDEX_ARTIFACT} (${code}).`,
    );
  }
  const blob = result.data;
  if (!blob || typeof blob !== "object") {
    throw searchIndexMcpError(
      "not_found",
      "Search index snapshot unavailable.",
    );
  }
  const transformed = applyQueryFilters(blob, queryUrl, "documents", []);
  if (transformed.error) {
    throw searchIndexMcpError("invalid_params", transformed.error.message);
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

export const LIST_SEARCH_INDEX_INSTRUCTIONS =
  "Use list_search_index to page the slim registry search index (title/slug " +
  "documents without token blobs; mirrors GET /api/v1/search-index), ";

export const LIST_SEARCH_INDEX_MCP_TOOL = {
  name: "list_search_index",
  title: "List search index documents",
  description:
    "Fetch slim search-index documents from the registry: subnet/provider " +
    "entries with title, slug, kind, and netuid without the heavy per-document " +
    "token blobs in search.json. Filter with q, sort with sort + order, project " +
    "with fields, and page with limit (1-100) / cursor. Use semantic_search for " +
    "meaning-based discovery or search_subnets for keyword subnet lookup. Mirrors " +
    "GET /api/v1/search-index.",
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

export const LIST_SEARCH_INDEX_OUTPUT_SCHEMA = {
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
