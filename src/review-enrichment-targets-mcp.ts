// Review enrichment targets list loader for MCP parity on
// GET /api/v1/review/enrichment-targets. Applies the same list-query
// transforms as the REST route over the baked
// /metagraph/review/enrichment-targets.json artifact.

import { applyQueryFilters, type Row } from "../workers/list-query.ts";
import type { StorageReadResult } from "../workers/storage.ts";
import { API_QUERY_COLLECTIONS, QUERY_ENUMS } from "./contracts.ts";

export const REVIEW_ENRICHMENT_TARGETS_ARTIFACT =
  "/metagraph/review/enrichment-targets.json";

const TARGET_SORT_FIELDS =
  API_QUERY_COLLECTIONS["enrichment-targets"].sort_fields;
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
const SUBMISSION_ROUTES = [
  "direct-candidate-pr",
  "adapter-request",
  "maintainer-review",
  "status-report",
];
const TARGET_ACTIONS = [
  "submit-new-candidate",
  "replace-stale-candidate",
  "verify-existing-candidate",
  "review-existing-candidate",
  "adapter-review",
  "maintainer-review",
  "monitoring-followup",
];
const TARGET_TYPES = [
  "surface-candidate",
  "adapter-review",
  "maintainer-review",
  "monitoring-followup",
];

export interface ReviewEnrichmentTargetsMcpError extends Error {
  toolError: true;
  code: string;
}

export function reviewEnrichmentTargetsMcpError(
  code: string,
  message: string,
): ReviewEnrichmentTargetsMcpError {
  const error = new Error(message) as ReviewEnrichmentTargetsMcpError;
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
    throw reviewEnrichmentTargetsMcpError(
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
    throw reviewEnrichmentTargetsMcpError(
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

export function reviewEnrichmentTargetsQueryUrl(
  args: Record<string, unknown> | null | undefined,
): URL {
  const url = new URL("https://mcp.internal/review/enrichment-targets");
  const q = optionalString(args, "q");
  if (q) url.searchParams.set("q", q);
  if (args?.netuid !== undefined) {
    const netuid = args.netuid;
    if (typeof netuid !== "number" || !Number.isInteger(netuid) || netuid < 0) {
      throw reviewEnrichmentTargetsMcpError(
        "invalid_params",
        "netuid must be a non-negative integer.",
      );
    }
    url.searchParams.set("netuid", String(netuid));
  }
  const targetType = optionalEnum(args, "target_type", TARGET_TYPES);
  if (targetType) url.searchParams.set("target_type", targetType);
  const targetAction = optionalEnum(args, "target_action", TARGET_ACTIONS);
  if (targetAction) url.searchParams.set("target_action", targetAction);
  const kind = optionalEnum(args, "kind", SURFACE_KINDS);
  if (kind) url.searchParams.set("kind", kind);
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
  const profileLevel = optionalEnum(args, "profile_level", PROFILE_LEVELS);
  if (profileLevel) url.searchParams.set("profile_level", profileLevel);
  const submissionRoute = optionalEnum(
    args,
    "submission_route",
    SUBMISSION_ROUTES,
  );
  if (submissionRoute)
    url.searchParams.set("submission_route", submissionRoute);
  const autoReviewCandidate = optionalEnum(
    args,
    "auto_review_candidate",
    BOOLEAN_STRINGS,
  );
  if (autoReviewCandidate) {
    url.searchParams.set("auto_review_candidate", autoReviewCandidate);
  }
  const manualReviewRequired = optionalEnum(
    args,
    "manual_review_required",
    BOOLEAN_STRINGS,
  );
  if (manualReviewRequired) {
    url.searchParams.set("manual_review_required", manualReviewRequired);
  }
  const missingKinds = optionalEnum(args, "missing_kinds", SURFACE_KINDS);
  if (missingKinds) url.searchParams.set("missing_kinds", missingKinds);
  const reasonCodes = optionalString(args, "reason_codes");
  if (reasonCodes) url.searchParams.set("reason_codes", reasonCodes);
  const sort = optionalEnum(args, "sort", TARGET_SORT_FIELDS);
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
      throw reviewEnrichmentTargetsMcpError(
        "invalid_params",
        "cursor must be a non-negative integer.",
      );
    }
    url.searchParams.set("cursor", String(cursor));
  }
  return url;
}

export interface ReviewEnrichmentTargetsListResult {
  generated_at: unknown;
  notes: unknown;
  targets: Row[];
  total: unknown;
  returned: unknown;
  limit: unknown;
  cursor: unknown;
  next_cursor: unknown;
  sort: unknown;
  order: unknown;
}

export async function loadReviewEnrichmentTargetsList(
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
): Promise<ReviewEnrichmentTargetsListResult> {
  const queryUrl = reviewEnrichmentTargetsQueryUrl(args);
  const read = readArtifact ?? ctx.readArtifact;
  const result = await read(ctx.env, REVIEW_ENRICHMENT_TARGETS_ARTIFACT);
  if (!result?.ok) {
    const code =
      (result as { code?: string } | undefined)?.code || "artifact_unavailable";
    if (code === "artifact_not_found") {
      throw reviewEnrichmentTargetsMcpError(
        "not_found",
        "Review enrichment targets snapshot unavailable.",
      );
    }
    throw reviewEnrichmentTargetsMcpError(
      code,
      `Could not load ${REVIEW_ENRICHMENT_TARGETS_ARTIFACT} (${code}).`,
    );
  }
  const blob = result.data;
  if (!blob || typeof blob !== "object") {
    throw reviewEnrichmentTargetsMcpError(
      "not_found",
      "Review enrichment targets snapshot unavailable.",
    );
  }
  const transformed = applyQueryFilters(
    blob as Record<string, unknown>,
    queryUrl,
    "enrichment-targets",
    [],
  );
  if (transformed.error) {
    throw reviewEnrichmentTargetsMcpError(
      "invalid_params",
      transformed.error.message,
    );
  }
  const data = transformed.data as Record<string, unknown>;
  const meta = transformed.meta as Record<string, unknown>;
  const page = (meta.pagination as Record<string, unknown>) || {};
  const rows = Array.isArray(data.targets) ? (data.targets as Row[]) : [];
  const rowLen = rows.length;
  return {
    generated_at: data.generated_at ?? null,
    notes: data.notes ?? null,
    targets: rows,
    total: page.total ?? rowLen,
    returned: page.returned ?? rowLen,
    limit: page.limit ?? rowLen,
    cursor: page.cursor ?? 0,
    next_cursor: page.next_cursor ?? null,
    sort: page.sort ?? null,
    order: page.order ?? null,
  };
}

export const LIST_REVIEW_ENRICHMENT_TARGETS_INSTRUCTIONS =
  "list_review_enrichment_targets the contributor-facing enrichment target board " +
  "(target_type, target_action, lane, and priority_score; mirrors " +
  "GET /api/v1/review/enrichment-targets), ";

export const LIST_REVIEW_ENRICHMENT_TARGETS_MCP_TOOL = {
  name: "list_review_enrichment_targets",
  title: "List review enrichment targets",
  description:
    "Fetch the contributor-facing enrichment target board from the registry: " +
    "per-subnet target_type, target_action, lane, priority_score, missing surface " +
    "kinds, submission_route, and recommended_action. Filter by netuid, target_type, " +
    "target_action, kind, lane, evidence_action, identity_level, profile_level, " +
    "submission_route, auto_review_candidate, manual_review_required, missing_kinds, " +
    "or reason_codes; search with q; sort with sort + order; and page with limit " +
    "(1-100) / cursor. Distinct from list_enrichment_targets (coverage-depth scorecard) " +
    "and list_enrichment_queue (prioritized queue summary). Mirrors " +
    "GET /api/v1/review/enrichment-targets.",
  inputSchema: {
    type: "object",
    properties: {
      q: {
        type: "string",
        description:
          "Keyword search across name, slug, contribution_prompt, recommended_action, and reason_codes.",
      },
      netuid: {
        type: "integer",
        description: "Filter to one subnet netuid.",
        minimum: 0,
      },
      target_type: {
        type: "string",
        enum: TARGET_TYPES,
        description:
          "Filter by target type (surface-candidate, adapter-review, etc.).",
      },
      target_action: {
        type: "string",
        enum: TARGET_ACTIONS,
        description: "Filter by the recommended target action.",
      },
      kind: {
        type: "string",
        enum: SURFACE_KINDS,
        description: "Filter by surface kind.",
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
      profile_level: {
        type: "string",
        enum: PROFILE_LEVELS,
        description: "Filter by profile completeness.",
      },
      submission_route: {
        type: "string",
        enum: SUBMISSION_ROUTES,
        description: "Filter by contributor submission route.",
      },
      auto_review_candidate: {
        type: "string",
        enum: BOOLEAN_STRINGS,
        description:
          "Filter by whether the target is an auto-review candidate.",
      },
      manual_review_required: {
        type: "string",
        enum: BOOLEAN_STRINGS,
        description: "Filter by whether manual review is required.",
      },
      missing_kinds: {
        type: "string",
        enum: SURFACE_KINDS,
        description: "Filter rows whose missing_kinds include this kind.",
      },
      reason_codes: {
        type: "string",
        description: "Filter by reason_codes substring match.",
      },
      sort: {
        type: "string",
        enum: TARGET_SORT_FIELDS,
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
          "Comma-separated projection of target row fields to return.",
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

export const LIST_REVIEW_ENRICHMENT_TARGETS_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: ["targets"],
  properties: {
    generated_at: NULLABLE_STRING,
    notes: {
      type: ["array", "string", "null"],
      items: { type: "string" },
    },
    targets: { type: "array", items: { type: "object" } },
    total: { type: "integer" },
    returned: { type: "integer" },
    limit: { type: "integer" },
    cursor: { type: "integer" },
    next_cursor: NULLABLE_INT,
    sort: NULLABLE_STRING,
    order: NULLABLE_STRING,
  },
};
