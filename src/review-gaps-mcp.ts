// Review gap priorities list loader for MCP parity on GET /api/v1/review/gaps.
// Applies the same list-query transforms as the REST route over the baked
// /metagraph/review/gap-priorities.json artifact.

import { z } from "zod";
import { applyQueryFilters, type Row } from "../workers/list-query.ts";
import type { StorageReadResult } from "../workers/storage.ts";
import { API_QUERY_COLLECTIONS, QUERY_ENUMS } from "./contracts.ts";
import {
  ListReviewGapsInputSchema,
  ListReviewGapsOutputSchema,
} from "../schemas-src/mcp-tools/enrichment-evidence-and-targets.ts";

export const REVIEW_GAPS_ARTIFACT = "/metagraph/review/gap-priorities.json";

const PRIORITY_SORT_FIELDS =
  API_QUERY_COLLECTIONS["review-gap-priorities"].sort_fields;
const CURATION_LEVELS = QUERY_ENUMS.curationLevel;
const SURFACE_KINDS = QUERY_ENUMS.surfaceKind;

export interface ReviewGapsMcpError extends Error {
  toolError: true;
  code: string;
}

export function reviewGapsMcpError(
  code: string,
  message: string,
): ReviewGapsMcpError {
  const error = new Error(message) as ReviewGapsMcpError;
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
    throw reviewGapsMcpError(
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
    throw reviewGapsMcpError(
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

export function reviewGapsQueryUrl(
  args: Record<string, unknown> | null | undefined,
): URL {
  const url = new URL("https://mcp.internal/review/gaps");
  if (args?.netuid !== undefined) {
    const netuid = args.netuid;
    if (typeof netuid !== "number" || !Number.isInteger(netuid) || netuid < 0) {
      throw reviewGapsMcpError(
        "invalid_params",
        "netuid must be a non-negative integer.",
      );
    }
    url.searchParams.set("netuid", String(netuid));
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
    const cursor = args.cursor;
    if (typeof cursor !== "number" || !Number.isInteger(cursor) || cursor < 0) {
      throw reviewGapsMcpError(
        "invalid_params",
        "cursor must be a non-negative integer.",
      );
    }
    url.searchParams.set("cursor", String(cursor));
  }
  return url;
}

export interface ReviewGapsListResult {
  generated_at: unknown;
  notes: unknown;
  priorities: Row[];
  total: unknown;
  returned: unknown;
  limit: unknown;
  cursor: unknown;
  next_cursor: unknown;
  sort: unknown;
  order: unknown;
}

export async function loadReviewGapsList(
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
): Promise<ReviewGapsListResult> {
  const queryUrl = reviewGapsQueryUrl(args);
  const read = readArtifact ?? ctx.readArtifact;
  const result = await read(ctx.env, REVIEW_GAPS_ARTIFACT);
  if (!result?.ok) {
    const code =
      (result as { code?: string } | undefined)?.code || "artifact_unavailable";
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
    blob as Record<string, unknown>,
    queryUrl,
    "review-gap-priorities",
    [],
  );
  if (transformed.error) {
    throw reviewGapsMcpError("invalid_params", transformed.error.message);
  }
  const data = transformed.data as Record<string, unknown>;
  const meta = transformed.meta as Record<string, unknown>;
  const page = (meta.pagination as Record<string, unknown>) || {};
  const rows = Array.isArray(data.priorities) ? (data.priorities as Row[]) : [];
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
  inputSchema: z.toJSONSchema(ListReviewGapsInputSchema, {
    target: "draft-2020-12",
  }),
};

export const LIST_REVIEW_GAPS_OUTPUT_SCHEMA = z.toJSONSchema(
  ListReviewGapsOutputSchema,
  {
    target: "draft-2020-12",
  },
);
