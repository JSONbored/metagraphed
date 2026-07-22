// Per-subnet evidence claims list loader for MCP parity on
// GET /api/v1/subnets/{netuid}/evidence. Applies the same list-query
// transforms as the REST route over the baked
// /metagraph/evidence/{netuid}.json artifact.

import { applyQueryFilters } from "../workers/list-query.ts";
import { API_QUERY_COLLECTIONS } from "./contracts.mjs";

const CLAIM_SORT_FIELDS = API_QUERY_COLLECTIONS.claims.sort_fields;

export function subnetEvidenceArtifactPath(netuid) {
  return `/metagraph/evidence/${netuid}.json`;
}

export function subnetEvidenceMcpError(code, message) {
  const error = new Error(message);
  error.toolError = true;
  error.code = code;
  return error;
}

function requireNetuid(args) {
  const netuid = args?.netuid;
  if (!Number.isInteger(netuid) || netuid < 0) {
    throw subnetEvidenceMcpError(
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
    throw subnetEvidenceMcpError(
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
    throw subnetEvidenceMcpError(
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

export function subnetEvidenceQueryUrl(args) {
  const url = new URL("https://mcp.internal/subnets/evidence");
  requireNetuid(args);
  const q = optionalString(args, "q");
  if (q) url.searchParams.set("q", q);
  const sort = optionalEnum(args, "sort", CLAIM_SORT_FIELDS);
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
      throw subnetEvidenceMcpError(
        "invalid_params",
        "cursor must be a non-negative integer.",
      );
    }
    url.searchParams.set("cursor", String(args.cursor));
  }
  return url;
}

export async function loadSubnetEvidenceList(ctx, args, { readArtifact } = {}) {
  const netuid = requireNetuid(args);
  const queryUrl = subnetEvidenceQueryUrl(args);
  const artifactPath = subnetEvidenceArtifactPath(netuid);
  const read = readArtifact ?? ctx.readArtifact;
  const result = await read(ctx.env, artifactPath);
  if (!result?.ok) {
    const code = result?.code || "artifact_unavailable";
    if (code === "artifact_not_found") {
      throw subnetEvidenceMcpError(
        "not_found",
        `No evidence snapshot exists for netuid ${netuid}.`,
      );
    }
    throw subnetEvidenceMcpError(
      code,
      `Could not load ${artifactPath} (${code}).`,
    );
  }
  const blob = result.data;
  if (!blob || typeof blob !== "object") {
    throw subnetEvidenceMcpError(
      "not_found",
      `No evidence snapshot exists for netuid ${netuid}.`,
    );
  }
  const transformed = applyQueryFilters(blob, queryUrl, "claims", []);
  if (transformed.error) {
    throw subnetEvidenceMcpError("invalid_params", transformed.error.message);
  }
  const { data, meta } = transformed;
  const page = meta.pagination || {};
  const rows = Array.isArray(data.claims) ? data.claims : [];
  const rowLen = rows.length;
  return {
    generated_at: data.generated_at ?? null,
    netuid: data.netuid ?? netuid,
    claims: rows,
    total: page.total ?? rowLen,
    returned: page.returned ?? rowLen,
    limit: page.limit ?? rowLen,
    cursor: page.cursor ?? 0,
    next_cursor: page.next_cursor ?? null,
    sort: page.sort ?? null,
    order: page.order ?? null,
  };
}

export const LIST_SUBNET_EVIDENCE_INSTRUCTIONS =
  "list_subnet_evidence one subnet's evidence ledger claims with REST list-query " +
  "filters (q, sort, and pagination; mirrors GET /api/v1/subnets/{netuid}/evidence), ";

export const LIST_SUBNET_EVIDENCE_MCP_TOOL = {
  name: "list_subnet_evidence",
  title: "List one subnet's evidence claims",
  description:
    "Fetch public evidence-ledger claims for one subnet by netuid: provenance " +
    "and verification evidence recorded for that subnet's surfaces (what was " +
    "checked and the outcome). Search with q across subject, claim, source_url, " +
    "and support_summary; sort with sort + order; and page with limit (1-100) / " +
    "cursor. Distinct from get_subnet_evidence (raw artifact dump) and " +
    "list_evidence (network-wide ledger). Mirrors " +
    "GET /api/v1/subnets/{netuid}/evidence.",
  inputSchema: {
    type: "object",
    properties: {
      netuid: {
        type: "integer",
        description: "Subnet netuid.",
        minimum: 0,
      },
      q: {
        type: "string",
        description:
          "Keyword search across subject, claim, source_url, and support_summary.",
      },
      sort: {
        type: "string",
        enum: CLAIM_SORT_FIELDS,
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
          "Comma-separated projection of claim row fields to return.",
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

export const LIST_SUBNET_EVIDENCE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: ["claims"],
  properties: {
    generated_at: NULLABLE_STRING,
    netuid: NULLABLE_INT,
    claims: { type: "array", items: { type: "object" } },
    total: { type: "integer" },
    returned: { type: "integer" },
    limit: { type: "integer" },
    cursor: { type: "integer" },
    next_cursor: NULLABLE_INT,
    sort: NULLABLE_STRING,
    order: NULLABLE_STRING,
  },
};
