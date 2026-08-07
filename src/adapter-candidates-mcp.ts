// Adapter candidates list loader for MCP parity on GET /api/v1/review/adapter-candidates.
// Applies the same list-query transforms as the REST route over the baked
// /metagraph/review/adapter-candidates.json artifact.

import { z } from "zod";
import { applyMcpQueryFilters, type Row } from "./mcp-list-query.ts";
import type { StorageReadResult } from "../workers/storage.ts";
import { API_QUERY_COLLECTIONS, QUERY_ENUMS } from "./contracts.ts";
import {
  ListAdapterCandidatesInputSchema,
  ListAdapterCandidatesOutputSchema,
} from "../schemas-src/mcp-tools/enrichment-queue-and-candidates.ts";

export const ADAPTER_CANDIDATES_ARTIFACT =
  "/metagraph/review/adapter-candidates.json";

const CANDIDATE_SORT_FIELDS =
  API_QUERY_COLLECTIONS["adapter-candidates"].sort_fields;
const CURATION_LEVELS = QUERY_ENUMS.curationLevel;
const SURFACE_KINDS = QUERY_ENUMS.surfaceKind;
const RECOMMENDED_ADAPTER_KINDS = QUERY_ENUMS.recommendedAdapterKind;

export interface AdapterCandidatesMcpError extends Error {
  toolError: true;
  code: string;
}

export function adapterCandidatesMcpError(
  code: string,
  message: string,
): AdapterCandidatesMcpError {
  const error = new Error(message) as AdapterCandidatesMcpError;
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
    throw adapterCandidatesMcpError(
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
    throw adapterCandidatesMcpError(
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

export function adapterCandidatesQueryUrl(
  args: Record<string, unknown> | null | undefined,
): URL {
  const url = new URL("https://mcp.internal/review/adapter-candidates");
  if (args?.netuid !== undefined) {
    const netuid = args.netuid;
    if (typeof netuid !== "number" || !Number.isInteger(netuid) || netuid < 0) {
      throw adapterCandidatesMcpError(
        "invalid_params",
        "netuid must be a non-negative integer.",
      );
    }
    url.searchParams.set("netuid", String(netuid));
  }
  const curationLevel = optionalEnum(args, "curation_level", CURATION_LEVELS);
  if (curationLevel) url.searchParams.set("curation_level", curationLevel);
  const candidateApiKinds = optionalEnum(
    args,
    "candidate_api_kinds",
    SURFACE_KINDS,
  );
  if (candidateApiKinds) {
    url.searchParams.set("candidate_api_kinds", candidateApiKinds);
  }
  const operationalKinds = optionalEnum(
    args,
    "operational_kinds",
    SURFACE_KINDS,
  );
  if (operationalKinds) {
    url.searchParams.set("operational_kinds", operationalKinds);
  }
  const recommendedAdapterKind = optionalEnum(
    args,
    "recommended_adapter_kind",
    RECOMMENDED_ADAPTER_KINDS,
  );
  if (recommendedAdapterKind) {
    url.searchParams.set("recommended_adapter_kind", recommendedAdapterKind);
  }
  const reasonCodes = optionalString(args, "reason_codes");
  if (reasonCodes) url.searchParams.set("reason_codes", reasonCodes);
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
    const cursor = args.cursor;
    if (typeof cursor !== "number" || !Number.isInteger(cursor) || cursor < 0) {
      throw adapterCandidatesMcpError(
        "invalid_params",
        "cursor must be a non-negative integer.",
      );
    }
    url.searchParams.set("cursor", String(cursor));
  }
  return url;
}

export interface AdapterCandidatesListResult {
  generated_at: unknown;
  notes: unknown;
  candidates: Row[];
  total: unknown;
  returned: unknown;
  limit: unknown;
  cursor: unknown;
  next_cursor: unknown;
  sort: unknown;
  order: unknown;
}

export async function loadAdapterCandidatesList(
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
): Promise<AdapterCandidatesListResult> {
  const queryUrl = adapterCandidatesQueryUrl(args);
  const read = readArtifact ?? ctx.readArtifact;
  const result = await read(ctx.env, ADAPTER_CANDIDATES_ARTIFACT);
  if (!result?.ok) {
    const code =
      (result as { code?: string } | undefined)?.code || "artifact_unavailable";
    if (code === "artifact_not_found") {
      throw adapterCandidatesMcpError(
        "not_found",
        "Adapter candidates snapshot unavailable.",
      );
    }
    throw adapterCandidatesMcpError(
      code,
      `Could not load ${ADAPTER_CANDIDATES_ARTIFACT} (${code}).`,
    );
  }
  const blob = result.data;
  if (!blob || typeof blob !== "object") {
    throw adapterCandidatesMcpError(
      "not_found",
      "Adapter candidates snapshot unavailable.",
    );
  }
  const transformed = applyMcpQueryFilters(
    blob as Record<string, unknown>,
    queryUrl,
    "adapter-candidates",
    [],
  );
  if (transformed.error) {
    throw adapterCandidatesMcpError(
      "invalid_params",
      transformed.error.message,
    );
  }
  const data = transformed.data as Record<string, unknown> | undefined;
  const meta = (transformed.meta ?? {}) as Record<string, unknown>;
  const page = (meta.pagination as Record<string, unknown>) || {};
  const rows: Row[] = Array.isArray(data?.candidates)
    ? (data.candidates as Row[])
    : [];
  const rowLen = rows.length;
  return {
    generated_at: data?.generated_at ?? null,
    notes: data?.notes ?? null,
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

export const LIST_ADAPTER_CANDIDATES_INSTRUCTIONS =
  "list_adapter_candidates subnets worth deeper adapter work (recommended_adapter_kind, " +
  "operational_kinds, and priority_score; mirrors GET /api/v1/review/adapter-candidates), ";

export const LIST_ADAPTER_CANDIDATES_MCP_TOOL = {
  name: "list_adapter_candidates",
  title: "List review adapter candidates",
  description:
    "Fetch subnets worth deeper adapter work from the registry: " +
    "recommended_adapter_kind, operational and candidate API kinds, " +
    "priority_score, and reason_codes per subnet. Filter by netuid, curation_level, " +
    "candidate_api_kinds, operational_kinds, recommended_adapter_kind, or reason_codes; " +
    "sort with sort + order; and page with limit (1-100) / cursor. Complements " +
    "get_adapter (one adapter by slug) and list_enrichment_queue (full enrichment lanes). " +
    "Mirrors GET /api/v1/review/adapter-candidates.",
  inputSchema: z.toJSONSchema(ListAdapterCandidatesInputSchema, {
    target: "draft-2020-12",
  }),
};

export const LIST_ADAPTER_CANDIDATES_OUTPUT_SCHEMA = z.toJSONSchema(
  ListAdapterCandidatesOutputSchema,
  {
    target: "draft-2020-12",
  },
);
