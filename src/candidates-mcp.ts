// Candidates list loader for MCP parity on GET /api/v1/candidates.
// Applies the same list-query transforms as the REST route over the baked
// /metagraph/candidates.json artifact (mirrors gaps-mcp.ts for GET /api/v1/gaps).

import {
  CANDIDATES_LIMIT_DEFAULT,
  CANDIDATES_LIMIT_MAX,
} from "./route-limits.ts";
import { z } from "zod";
import { applyQueryFilters, type Row } from "../workers/list-query.ts";
import type { StorageReadResult } from "../workers/storage.ts";
import { API_QUERY_COLLECTIONS, QUERY_ENUMS } from "./contracts.ts";
import {
  ListCandidatesInputSchema,
  ListCandidatesOutputSchema,
} from "../schemas-src/mcp-tools/registry-catalogs-1.ts";

export const CANDIDATES_ARTIFACT = "/metagraph/candidates.json";

const CANDIDATES_SORT_FIELDS = API_QUERY_COLLECTIONS.candidates.sort_fields;
const SURFACE_KINDS = QUERY_ENUMS.surfaceKind;
const CANDIDATE_STATES = QUERY_ENUMS.candidateState;
const CONFIDENCE_LEVELS = ["low", "medium", "high"];

export interface CandidatesMcpError extends Error {
  toolError: true;
  code: string;
}

export function candidatesMcpError(
  code: string,
  message: string,
): CandidatesMcpError {
  const error = new Error(message) as CandidatesMcpError;
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
    throw candidatesMcpError(
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
    throw candidatesMcpError(
      "invalid_params",
      `Argument \`${key}\` must be one of: ${allowed.join(", ")}.`,
    );
  }
  return value;
}

export function candidatesQueryUrl(
  args: Record<string, unknown> | null | undefined,
): URL {
  const url = new URL("https://mcp.internal/candidates");
  if (args?.netuid !== undefined) {
    const netuid = args.netuid;
    if (typeof netuid !== "number" || !Number.isInteger(netuid) || netuid < 0) {
      throw candidatesMcpError(
        "invalid_params",
        "netuid must be a non-negative integer.",
      );
    }
    url.searchParams.set("netuid", String(netuid));
  }
  const kind = optionalEnum(args, "kind", SURFACE_KINDS);
  if (kind) url.searchParams.set("kind", kind);
  const provider = optionalString(args, "provider");
  if (provider) url.searchParams.set("provider", provider);
  const state = optionalEnum(args, "state", CANDIDATE_STATES);
  if (state) url.searchParams.set("state", state);
  const id = optionalString(args, "id");
  if (id) url.searchParams.set("id", id);
  const confidence = optionalEnum(args, "confidence", CONFIDENCE_LEVELS);
  if (confidence) url.searchParams.set("confidence", confidence);
  const sort = optionalEnum(args, "sort", CANDIDATES_SORT_FIELDS);
  if (sort) url.searchParams.set("sort", sort);
  const order = optionalEnum(args, "order", ["asc", "desc"]);
  if (order) url.searchParams.set("order", order);
  const fields = optionalString(args, "fields");
  if (fields) url.searchParams.set("fields", fields);
  if (args?.limit !== undefined) {
    const limit = args.limit;
    if (
      typeof limit !== "number" ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > CANDIDATES_LIMIT_MAX
    ) {
      throw candidatesMcpError(
        "invalid_params",
        `limit must be an integer between 1 and ${CANDIDATES_LIMIT_MAX}.`,
      );
    }
    url.searchParams.set("limit", String(limit));
  } else {
    // DEFAULTED, because absent used to mean unbounded (#9700). This tool
    // takes no required arguments, so `list_candidates {}` is the obvious
    // first call -- and it returned 7,537,056 bytes, ~1.9M tokens, roughly ten
    // context windows. Not a big answer: no usable answer. The envelope still
    // carries `total` and `next_cursor`, so the whole catalog is reachable by
    // paging rather than by accident.
    url.searchParams.set("limit", String(CANDIDATES_LIMIT_DEFAULT));
  }
  if (args?.cursor !== undefined) {
    const cursor = args.cursor;
    if (typeof cursor !== "number" || !Number.isInteger(cursor) || cursor < 0) {
      throw candidatesMcpError(
        "invalid_params",
        "cursor must be a non-negative integer.",
      );
    }
    url.searchParams.set("cursor", String(cursor));
  }
  return url;
}

export interface CandidatesListResult {
  generated_at: unknown;
  notes: unknown;
  schema_version: unknown;
  candidates: Row[];
  total: unknown;
  returned: unknown;
  limit: unknown;
  cursor: unknown;
  next_cursor: unknown;
  sort: unknown;
  order: unknown;
}

export async function loadCandidatesList(
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
): Promise<CandidatesListResult> {
  const queryUrl = candidatesQueryUrl(args);
  const read = readArtifact ?? ctx.readArtifact;
  const result = await read(ctx.env, CANDIDATES_ARTIFACT);
  if (!result?.ok) {
    const code =
      (result as { code?: string } | undefined)?.code || "artifact_unavailable";
    if (code === "artifact_not_found") {
      throw candidatesMcpError(
        "not_found",
        "Candidates catalog snapshot unavailable.",
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
      "Candidates catalog snapshot unavailable.",
    );
  }
  const transformed = applyQueryFilters(
    blob as Record<string, unknown>,
    queryUrl,
    "candidates",
    [],
  );
  if (transformed.error) {
    throw candidatesMcpError("invalid_params", transformed.error.message);
  }
  const data = transformed.data as Record<string, unknown>;
  const meta = (transformed.meta ?? {}) as Record<string, unknown>;
  const page = (meta.pagination as Record<string, unknown>) || {};
  const rows = Array.isArray(data.candidates) ? (data.candidates as Row[]) : [];
  const rowLen = rows.length;
  return {
    generated_at: data.generated_at ?? null,
    notes: data.notes ?? null,
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
  "list_candidates unpromoted candidate surfaces (filter by netuid/kind/" +
  "provider/state/id/confidence, sort with sort/order; mirrors GET /api/v1/candidates), ";

export const LIST_CANDIDATES_MCP_TOOL = {
  name: "list_candidates",
  title: "List unpromoted candidate surfaces",
  description:
    "Fetch unpromoted candidate surfaces across all subnets: surfaces that " +
    "have been discovered or proposed but not yet curated/promoted, each " +
    "with its subnet (netuid), kind, provider, review state, and confidence. " +
    "Filter by netuid/kind/provider/state/id/confidence, sort with sort + order, " +
    "and page with limit (1-1000) / cursor — the full catalog can be large. " +
    "Mirrors GET /api/v1/candidates.",
  inputSchema: z.toJSONSchema(ListCandidatesInputSchema, {
    target: "draft-2020-12",
  }),
};

export const LIST_CANDIDATES_OUTPUT_SCHEMA = z.toJSONSchema(
  ListCandidatesOutputSchema,
  {
    target: "draft-2020-12",
  },
);
