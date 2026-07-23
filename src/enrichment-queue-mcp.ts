// Enrichment queue list loader for MCP parity on GET /api/v1/review/enrichment-queue.
// Applies the same list-query transforms as the REST route over the baked
// /metagraph/review/enrichment-queue.json artifact.

import { applyQueryFilters, type Row } from "../workers/list-query.ts";
import type { StorageReadResult } from "../workers/storage.ts";
import { API_QUERY_COLLECTIONS, QUERY_ENUMS } from "./contracts.ts";

export const ENRICHMENT_QUEUE_ARTIFACT =
  "/metagraph/review/enrichment-queue.json";

const QUEUE_SORT_FIELDS = API_QUERY_COLLECTIONS["enrichment-queue"].sort_fields;
const CURATION_LEVELS = QUERY_ENUMS.curationLevel;
const PROFILE_LEVELS = QUERY_ENUMS.profileLevel;
const SURFACE_KINDS = QUERY_ENUMS.surfaceKind;
const EVIDENCE_ACTIONS = [
  "submit-new-evidence",
  "verify-existing-evidence",
  "replace-stale-evidence",
  "review-existing-evidence",
  "maintainer-review-existing-evidence",
  "monitor",
];
const IDENTITY_LEVELS = ["none", "directory", "partial", "complete"];
const LANES = [
  "direct-submission",
  "maintainer-review",
  "adapter-candidate",
  "monitoring-followup",
  "baseline-monitoring",
];
const BOOLEAN_STRINGS = ["true", "false"];

export interface EnrichmentQueueMcpError extends Error {
  toolError: true;
  code: string;
}

export function enrichmentQueueMcpError(
  code: string,
  message: string,
): EnrichmentQueueMcpError {
  const error = new Error(message) as EnrichmentQueueMcpError;
  error.toolError = true;
  error.code = code;
  return error;
}

function optionalString(
  args: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const value = args?.[key];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim() === "") {
    throw enrichmentQueueMcpError(
      "invalid_params",
      `Argument \`${key}\` must be a non-empty string when provided.`,
    );
  }
  return value.trim();
}

function optionalEnum(
  args: Record<string, unknown> | null | undefined,
  key: string,
  allowed: string[],
): string | null {
  const value = args?.[key];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw enrichmentQueueMcpError(
      "invalid_params",
      `Argument \`${key}\` must be one of: ${allowed.join(", ")}.`,
    );
  }
  return value;
}

function clampLimit(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number") return fallback;
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.min(max, Math.floor(value));
}

export function enrichmentQueueQueryUrl(
  args: Record<string, unknown> | null | undefined,
): URL {
  const url = new URL("https://mcp.internal/review/enrichment-queue");
  const q = optionalString(args, "q");
  if (q) url.searchParams.set("q", q);
  if (args?.netuid !== undefined) {
    const netuid = args.netuid;
    if (typeof netuid !== "number" || !Number.isInteger(netuid) || netuid < 0) {
      throw enrichmentQueueMcpError(
        "invalid_params",
        "netuid must be a non-negative integer.",
      );
    }
    url.searchParams.set("netuid", String(netuid));
  }
  const lane = optionalEnum(args, "lane", LANES);
  if (lane) url.searchParams.set("lane", lane);
  const evidenceAction = optionalEnum(
    args,
    "evidence_action",
    EVIDENCE_ACTIONS,
  );
  if (evidenceAction) url.searchParams.set("evidence_action", evidenceAction);
  const identityLevel = optionalEnum(args, "identity_level", IDENTITY_LEVELS);
  if (identityLevel) url.searchParams.set("identity_level", identityLevel);
  const curationLevel = optionalEnum(args, "curation_level", CURATION_LEVELS);
  if (curationLevel) url.searchParams.set("curation_level", curationLevel);
  const profileLevel = optionalEnum(args, "profile_level", PROFILE_LEVELS);
  if (profileLevel) url.searchParams.set("profile_level", profileLevel);
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
  const manualReviewRequired = optionalEnum(
    args,
    "manual_review_required",
    BOOLEAN_STRINGS,
  );
  if (manualReviewRequired) {
    url.searchParams.set("manual_review_required", manualReviewRequired);
  }
  const reasonCodes = optionalString(args, "reason_codes");
  if (reasonCodes) url.searchParams.set("reason_codes", reasonCodes);
  const reviewState = optionalString(args, "review_state");
  if (reviewState) url.searchParams.set("review_state", reviewState);
  const sort = optionalEnum(args, "sort", QUEUE_SORT_FIELDS);
  if (sort) url.searchParams.set("sort", sort);
  const order = optionalEnum(args, "order", ["asc", "desc"]);
  if (order) url.searchParams.set("order", order);
  const fields = optionalString(args, "fields");
  if (fields) url.searchParams.set("fields", fields);
  if (args?.limit !== undefined) {
    url.searchParams.set("limit", String(clampLimit(args.limit, 50, 100)));
  }
  if (args?.cursor !== undefined) {
    const cursor = args.cursor;
    if (typeof cursor !== "number" || !Number.isInteger(cursor) || cursor < 0) {
      throw enrichmentQueueMcpError(
        "invalid_params",
        "cursor must be a non-negative integer.",
      );
    }
    url.searchParams.set("cursor", String(cursor));
  }
  return url;
}

export interface EnrichmentQueueListResult {
  generated_at: unknown;
  notes: unknown;
  queue: Row[];
  total: unknown;
  returned: unknown;
  limit: unknown;
  cursor: unknown;
  next_cursor: unknown;
  sort: unknown;
  order: unknown;
}

export async function loadEnrichmentQueueList(
  ctx: {
    env: Env;
    readArtifact: (env: Env, path: string) => Promise<StorageReadResult>;
  },
  args: Record<string, unknown> | null | undefined,
  {
    readArtifact,
  }: {
    readArtifact?: (env: Env, path: string) => Promise<StorageReadResult>;
  } = {},
): Promise<EnrichmentQueueListResult> {
  const queryUrl = enrichmentQueueQueryUrl(args);
  const read = readArtifact ?? ctx.readArtifact;
  const result = await read(ctx.env, ENRICHMENT_QUEUE_ARTIFACT);
  if (!result?.ok) {
    const code =
      (result as { code?: string } | undefined)?.code || "artifact_unavailable";
    if (code === "artifact_not_found") {
      throw enrichmentQueueMcpError(
        "not_found",
        "Enrichment queue snapshot unavailable.",
      );
    }
    throw enrichmentQueueMcpError(
      code,
      `Could not load ${ENRICHMENT_QUEUE_ARTIFACT} (${code}).`,
    );
  }
  const blob = result.data;
  if (!blob || typeof blob !== "object") {
    throw enrichmentQueueMcpError(
      "not_found",
      "Enrichment queue snapshot unavailable.",
    );
  }
  const transformed = applyQueryFilters(
    blob as Record<string, unknown>,
    queryUrl,
    "enrichment-queue",
    [],
  );
  if (transformed.error) {
    throw enrichmentQueueMcpError("invalid_params", transformed.error.message);
  }
  const data = transformed.data as Record<string, unknown>;
  const meta = transformed.meta as Record<string, unknown>;
  const page = (meta.pagination as Record<string, unknown>) || {};
  const rows = Array.isArray(data.queue) ? (data.queue as Row[]) : [];
  const rowLen = rows.length;
  return {
    generated_at: data.generated_at ?? null,
    notes: data.notes ?? null,
    queue: rows,
    total: page.total ?? rowLen,
    returned: page.returned ?? rowLen,
    limit: page.limit ?? rowLen,
    cursor: page.cursor ?? 0,
    next_cursor: page.next_cursor ?? null,
    sort: page.sort ?? null,
    order: page.order ?? null,
  };
}

export const LIST_ENRICHMENT_QUEUE_INSTRUCTIONS =
  "list_enrichment_queue the prioritized all-subnet contributor enrichment queue " +
  "(direct-submission, maintainer-review, adapter, and monitoring lanes; mirrors " +
  "GET /api/v1/review/enrichment-queue), ";

export const LIST_ENRICHMENT_QUEUE_MCP_TOOL = {
  name: "list_enrichment_queue",
  title: "List review enrichment queue entries",
  description:
    "Fetch the prioritized all-subnet enrichment queue from the registry: " +
    "contributor-facing targets with lane, priority_score, missing surface kinds, " +
    "direct-submission kinds, evidence_action, and recommended_action per subnet. " +
    "Filter by netuid, lane, evidence_action, identity_level, curation_level, " +
    "profile_level, direct_submission_kinds, missing_kinds, manual_review_required, " +
    "reason_codes, or review_state; search with q; sort with sort + order; and page " +
    "with limit (1-100) / cursor. Distinct from list_enrichment_targets (coverage-depth " +
    "scorecard) and get_subnet_gaps (one subnet's gap priorities + queue). Mirrors " +
    "GET /api/v1/review/enrichment-queue.",
  inputSchema: {
    type: "object",
    properties: {
      q: {
        type: "string",
        description:
          "Keyword search across name, slug, recommended_action, and reason_codes.",
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
      identity_level: {
        type: "string",
        enum: IDENTITY_LEVELS,
        description: "Filter by subnet identity completeness.",
      },
      curation_level: {
        type: "string",
        enum: CURATION_LEVELS,
        description: "Filter by curation level.",
      },
      profile_level: {
        type: "string",
        enum: PROFILE_LEVELS,
        description: "Filter by profile completeness.",
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
      manual_review_required: {
        type: "string",
        enum: BOOLEAN_STRINGS,
        description: "Filter by whether manual review is required.",
      },
      reason_codes: {
        type: "string",
        description: "Filter by reason_codes substring match.",
      },
      review_state: {
        type: "string",
        description: "Filter by review_state substring match.",
      },
      sort: {
        type: "string",
        enum: QUEUE_SORT_FIELDS,
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
          "Comma-separated projection of queue row fields to return.",
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

export const LIST_ENRICHMENT_QUEUE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: ["queue"],
  properties: {
    generated_at: NULLABLE_STRING,
    notes: {
      type: ["array", "string", "null"],
      items: { type: "string" },
    },
    queue: { type: "array", items: { type: "object" } },
    total: { type: "integer" },
    returned: { type: "integer" },
    limit: { type: "integer" },
    cursor: { type: "integer" },
    next_cursor: NULLABLE_INT,
    sort: NULLABLE_STRING,
    order: NULLABLE_STRING,
  },
};
