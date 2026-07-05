// Candidate surfaces list loader for MCP parity on GET /api/v1/candidates.
// Applies the same list-query transforms as the REST route over the baked
// /metagraph/candidates.json artifact.

import { applyQueryFilters } from "../workers/list-query.mjs";
import { API_QUERY_COLLECTIONS, QUERY_ENUMS } from "./contracts.mjs";

export const CANDIDATES_ARTIFACT = "/metagraph/candidates.json";

const CANDIDATE_SORT_FIELDS = API_QUERY_COLLECTIONS.candidates.sort_fields;
const SURFACE_KINDS = QUERY_ENUMS.surfaceKind;
const CANDIDATE_STATES = QUERY_ENUMS.candidateState;

export function candidatesMcpError(code, message) {
  const error = new Error(message);
  error.toolError = true;
  error.code = code;
  return error;
}

function optionalString(args, key) {
  const value = args?.[key];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim() === "") {
    throw candidatesMcpError(
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
    throw candidatesMcpError(
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

export function candidatesQueryUrl(args) {
  const url = new URL("https://mcp.internal/candidates");
  if (args?.netuid !== undefined) {
    if (!Number.isInteger(args.netuid) || args.netuid < 0) {
      throw candidatesMcpError(
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
  const state = optionalEnum(args, "state", CANDIDATE_STATES);
  if (state) url.searchParams.set("state", state);
  const sort = optionalEnum(args, "sort", CANDIDATE_SORT_FIELDS);
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
      throw candidatesMcpError(
        "invalid_params",
        "cursor must be a non-negative integer.",
      );
    }
    url.searchParams.set("cursor", String(args.cursor));
  }
  return url;
}

export async function loadCandidatesList(ctx, args, { readArtifact } = {}) {
  const queryUrl = candidatesQueryUrl(args);
  const read = readArtifact ?? ctx.readArtifact;
  const result = await read(ctx.env, CANDIDATES_ARTIFACT);
  if (!result?.ok) {
    const code = result?.code || "artifact_unavailable";
    if (code === "artifact_not_found") {
      throw candidatesMcpError(
        "not_found",
        "Candidate surfaces catalog unavailable.",
      );
    }
    throw candidatesMcpError(
      code,
      `Could not load ${CANDIDATES_ARTIFACT} (${code}).`,
    );
  }
  const blob = result.data;
  if (!blob || typeof blob !== "object") {
    throw candidatesMcpError(
      "not_found",
      "Candidate surfaces catalog unavailable.",
    );
  }
  const transformed = applyQueryFilters(blob, queryUrl, "candidates", []);
  if (transformed.error) {
    throw candidatesMcpError("invalid_params", transformed.error.message);
  }
  const { data, meta } = transformed;
  const page = meta.pagination || {};
  const rows = Array.isArray(data.candidates) ? data.candidates : [];
  const rowLen = rows.length;
  return {
    generated_at: data.generated_at ?? null,
    schema_version: data.schema_version ?? null,
    candidates: rows,
    total: page.total ?? rowLen,
    returned: page.returned ?? rowLen,
    limit: page.limit ?? rowLen,
    cursor: page.cursor ?? 0,
    next_cursor: page.next_cursor ?? null,
    sort: page.sort ?? null,
    order: page.order ?? null,
  };
}

export const LIST_CANDIDATES_INSTRUCTIONS =
  "Use list_candidates to page the network-wide unpromoted candidate-surface " +
  "catalog with REST list-query filters (netuid, kind, provider, state, sort, " +
  "and pagination; mirrors GET /api/v1/candidates), ";

export const LIST_CANDIDATES_MCP_TOOL = {
  name: "list_candidates",
  title: "List unpromoted candidate surfaces",
  description:
    "Fetch unpromoted candidate surfaces across all subnets: surfaces that " +
    "have been discovered or proposed but not yet curated/promoted, each with " +
    "its subnet (netuid), kind, provider, and review state. Filter by netuid, " +
    "kind, provider, or state; sort with sort + order; project with fields; and " +
    "page with limit (1-100) / cursor. Distinct from get_subnet_candidates (one " +
    "subnet's raw artifact dump). Mirrors GET /api/v1/candidates.",
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
      state: {
        type: "string",
        enum: CANDIDATE_STATES,
        description: "Review state, e.g. 'schema-valid' or 'verified'.",
      },
      sort: {
        type: "string",
        enum: CANDIDATE_SORT_FIELDS,
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
          "Comma-separated projection of candidate fields to return.",
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

export const LIST_CANDIDATES_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: ["candidates"],
  properties: {
    generated_at: NULLABLE_STRING,
    schema_version: { type: ["string", "integer", "null"] },
    candidates: { type: "array", items: { type: "object" } },
    total: { type: "integer" },
    returned: { type: "integer" },
    limit: { type: "integer" },
    cursor: { type: "integer" },
    next_cursor: NULLABLE_INT,
    sort: NULLABLE_STRING,
    order: NULLABLE_STRING,
  },
};
