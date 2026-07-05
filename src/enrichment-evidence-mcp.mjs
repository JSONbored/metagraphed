// Enrichment evidence list loader for MCP parity on GET /api/v1/review/enrichment-evidence.
// Applies the same list-query transforms as the REST route over the baked
// /metagraph/review/enrichment-evidence.json artifact.

import { applyQueryFilters } from "../workers/list-query.mjs";
import { API_QUERY_COLLECTIONS, QUERY_ENUMS } from "./contracts.mjs";

export const ENRICHMENT_EVIDENCE_ARTIFACT =
  "/metagraph/review/enrichment-evidence.json";

const EVIDENCE_SORT_FIELDS =
  API_QUERY_COLLECTIONS["enrichment-evidence"].sort_fields;
const SURFACE_KINDS = QUERY_ENUMS.surfaceKind;
const EVIDENCE_ACTIONS = [
  "submit-new-evidence",
  "verify-existing-evidence",
  "replace-stale-evidence",
  "review-existing-evidence",
  "maintainer-review-existing-evidence",
  "monitor",
];
const LANES = [
  "direct-submission",
  "maintainer-review",
  "adapter-candidate",
  "monitoring-followup",
  "baseline-monitoring",
];

export function enrichmentEvidenceMcpError(code, message) {
  const error = new Error(message);
  error.toolError = true;
  error.code = code;
  return error;
}

function optionalString(args, key) {
  const value = args?.[key];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim() === "") {
    throw enrichmentEvidenceMcpError(
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
    throw enrichmentEvidenceMcpError(
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

export function enrichmentEvidenceQueryUrl(args) {
  const url = new URL("https://mcp.internal/review/enrichment-evidence");
  const q = optionalString(args, "q");
  if (q) url.searchParams.set("q", q);
  if (args?.netuid !== undefined) {
    if (!Number.isInteger(args.netuid) || args.netuid < 0) {
      throw enrichmentEvidenceMcpError(
        "invalid_params",
        "netuid must be a non-negative integer.",
      );
    }
    url.searchParams.set("netuid", String(args.netuid));
  }
  const lane = optionalEnum(args, "lane", LANES);
  if (lane) url.searchParams.set("lane", lane);
  const evidenceAction = optionalEnum(
    args,
    "evidence_action",
    EVIDENCE_ACTIONS,
  );
  if (evidenceAction) url.searchParams.set("evidence_action", evidenceAction);
  const directSubmissionKinds = optionalEnum(
    args,
    "direct_submission_kinds",
    SURFACE_KINDS,
  );
  if (directSubmissionKinds) {
    url.searchParams.set("direct_submission_kinds", directSubmissionKinds);
  }
  const missingKinds = optionalEnum(args, "missing_kinds", SURFACE_KINDS);
  if (missingKinds) url.searchParams.set("missing_kinds", missingKinds);
  const sort = optionalEnum(args, "sort", EVIDENCE_SORT_FIELDS);
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
      throw enrichmentEvidenceMcpError(
        "invalid_params",
        "cursor must be a non-negative integer.",
      );
    }
    url.searchParams.set("cursor", String(args.cursor));
  }
  return url;
}

export async function loadEnrichmentEvidenceList(
  ctx,
  args,
  { readArtifact } = {},
) {
  const queryUrl = enrichmentEvidenceQueryUrl(args);
  const read = readArtifact ?? ctx.readArtifact;
  const result = await read(ctx.env, ENRICHMENT_EVIDENCE_ARTIFACT);
  if (!result?.ok) {
    const code = result?.code || "artifact_unavailable";
    if (code === "artifact_not_found") {
      throw enrichmentEvidenceMcpError(
        "not_found",
        "Enrichment evidence snapshot unavailable.",
      );
    }
    throw enrichmentEvidenceMcpError(
      code,
      `Could not load ${ENRICHMENT_EVIDENCE_ARTIFACT} (${code}).`,
    );
  }
  const blob = result.data;
  if (!blob || typeof blob !== "object") {
    throw enrichmentEvidenceMcpError(
      "not_found",
      "Enrichment evidence snapshot unavailable.",
    );
  }
  const transformed = applyQueryFilters(
    blob,
    queryUrl,
    "enrichment-evidence",
    [],
  );
  if (transformed.error) {
    throw enrichmentEvidenceMcpError(
      "invalid_params",
      transformed.error.message,
    );
  }
  const { data, meta } = transformed;
  const page = meta.pagination || {};
  const rows = Array.isArray(data.entries) ? data.entries : [];
  const rowLen = rows.length;
  return {
    generated_at: data.generated_at ?? null,
    notes: data.notes ?? null,
    entries: rows,
    total: page.total ?? rowLen,
    returned: page.returned ?? rowLen,
    limit: page.limit ?? rowLen,
    cursor: page.cursor ?? 0,
    next_cursor: page.next_cursor ?? null,
    sort: page.sort ?? null,
    order: page.order ?? null,
  };
}

export const LIST_ENRICHMENT_EVIDENCE_INSTRUCTIONS =
  "list_enrichment_evidence detailed candidate evidence behind the enrichment queue " +
  "(missing kinds, evidence_action, and lane; mirrors GET /api/v1/review/enrichment-evidence), ";

export const LIST_ENRICHMENT_EVIDENCE_MCP_TOOL = {
  name: "list_enrichment_evidence",
  title: "List review enrichment evidence entries",
  description:
    "Fetch detailed candidate evidence entries from the registry: per-subnet " +
    "evidence_action, lane, missing surface kinds, direct_submission_kinds, and " +
    "priority_score for contributor enrichment work. Filter by netuid, lane, " +
    "evidence_action, direct_submission_kinds, or missing_kinds; search with q; " +
    "sort with sort + order; and page with limit (1-100) / cursor. Distinct from " +
    "list_enrichment_queue (prioritized queue summary) and get_subnet_evidence " +
    "(one subnet's live evidence). Mirrors GET /api/v1/review/enrichment-evidence.",
  inputSchema: {
    type: "object",
    properties: {
      q: {
        type: "string",
        description: "Keyword search across name, slug, and evidence_action.",
      },
      netuid: {
        type: "integer",
        description: "Filter to one subnet netuid.",
        minimum: 0,
      },
      lane: {
        type: "string",
        enum: LANES,
        description:
          "Filter by enrichment lane (direct-submission, maintainer-review, etc.).",
      },
      evidence_action: {
        type: "string",
        enum: EVIDENCE_ACTIONS,
        description: "Filter by the recommended evidence action.",
      },
      direct_submission_kinds: {
        type: "string",
        enum: SURFACE_KINDS,
        description:
          "Filter rows whose direct_submission_kinds include this kind.",
      },
      missing_kinds: {
        type: "string",
        enum: SURFACE_KINDS,
        description: "Filter rows whose missing_kinds include this kind.",
      },
      sort: {
        type: "string",
        enum: EVIDENCE_SORT_FIELDS,
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
          "Comma-separated projection of evidence row fields to return.",
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

export const LIST_ENRICHMENT_EVIDENCE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: ["entries"],
  properties: {
    generated_at: NULLABLE_STRING,
    notes: {
      type: ["array", "string", "null"],
      items: { type: "string" },
    },
    entries: { type: "array", items: { type: "object" } },
    total: { type: "integer" },
    returned: { type: "integer" },
    limit: { type: "integer" },
    cursor: { type: "integer" },
    next_cursor: NULLABLE_INT,
    sort: NULLABLE_STRING,
    order: NULLABLE_STRING,
  },
};
