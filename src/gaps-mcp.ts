// Interface gaps list loader for MCP parity on GET /api/v1/gaps.
// Applies the same list-query transforms as the REST route over the baked
// /metagraph/gaps.json artifact.

import { z } from "zod";
import { applyMcpQueryFilters, type Row } from "./mcp-list-query.ts";
import type { StorageReadResult } from "../workers/storage.ts";
import { API_QUERY_COLLECTIONS, QUERY_ENUMS } from "./contracts.ts";
import {
  ListGapsInputSchema,
  ListGapsOutputSchema,
} from "../schemas-src/mcp-tools/curation-and-gaps.ts";

export const GAPS_ARTIFACT = "/metagraph/gaps.json";

const GAPS_SORT_FIELDS = API_QUERY_COLLECTIONS.gaps.sort_fields;
const COVERAGE_LEVELS = QUERY_ENUMS.coverageLevel;
const CURATION_LEVELS = QUERY_ENUMS.curationLevel;

export interface GapsMcpError extends Error {
  toolError: true;
  code: string;
}

export function gapsMcpError(code: string, message: string): GapsMcpError {
  const error = new Error(message) as GapsMcpError;
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
    throw gapsMcpError(
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
    throw gapsMcpError(
      "invalid_params",
      `Argument \`${key}\` must be one of: ${allowed.join(", ")}.`,
    );
  }
  return value;
}

export function gapsQueryUrl(
  args: Record<string, unknown> | null | undefined,
): URL {
  const url = new URL("https://mcp.internal/gaps");
  if (args?.netuid !== undefined) {
    const netuid = args.netuid;
    if (typeof netuid !== "number" || !Number.isInteger(netuid) || netuid < 0) {
      throw gapsMcpError(
        "invalid_params",
        "netuid must be a non-negative integer.",
      );
    }
    url.searchParams.set("netuid", String(netuid));
  }
  const coverageLevel = optionalEnum(args, "coverage_level", COVERAGE_LEVELS);
  if (coverageLevel) {
    url.searchParams.set("coverage_level", coverageLevel);
  }
  const curationLevel = optionalEnum(args, "curation_level", CURATION_LEVELS);
  if (curationLevel) {
    url.searchParams.set("curation_level", curationLevel);
  }
  const sort = optionalEnum(args, "sort", GAPS_SORT_FIELDS);
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
      limit > 100
    ) {
      throw gapsMcpError(
        "invalid_params",
        "limit must be an integer between 1 and 100.",
      );
    }
    url.searchParams.set("limit", String(limit));
  }
  if (args?.cursor !== undefined) {
    const cursor = args.cursor;
    if (typeof cursor !== "number" || !Number.isInteger(cursor) || cursor < 0) {
      throw gapsMcpError(
        "invalid_params",
        "cursor must be a non-negative integer.",
      );
    }
    url.searchParams.set("cursor", String(cursor));
  }
  return url;
}

export interface GapsListResult {
  generated_at: unknown;
  notes: unknown;
  gaps: Row[];
  total: unknown;
  returned: unknown;
  limit: unknown;
  cursor: unknown;
  next_cursor: unknown;
  sort: unknown;
  order: unknown;
}

export async function loadGapsList(
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
): Promise<GapsListResult> {
  const queryUrl = gapsQueryUrl(args);
  const read = readArtifact ?? ctx.readArtifact;
  const result = await read(ctx.env, GAPS_ARTIFACT);
  if (!result?.ok) {
    const code =
      (result as { code?: string } | undefined)?.code || "artifact_unavailable";
    if (code === "artifact_not_found") {
      throw gapsMcpError("not_found", "Interface gaps snapshot unavailable.");
    }
    throw gapsMcpError(code, `Could not load ${GAPS_ARTIFACT} (${code}).`);
  }
  const blob = result.data;
  if (!blob || typeof blob !== "object") {
    throw gapsMcpError("not_found", "Interface gaps snapshot unavailable.");
  }
  const transformed = applyMcpQueryFilters(
    blob as Record<string, unknown>,
    queryUrl,
    "gaps",
    [],
  );
  if (transformed.error) {
    throw gapsMcpError("invalid_params", transformed.error.message);
  }
  const data = transformed.data as Record<string, unknown>;
  const meta = transformed.meta as Record<string, unknown>;
  const page = (meta.pagination as Record<string, unknown>) || {};
  const rows = Array.isArray(data.gaps) ? (data.gaps as Row[]) : [];
  const rowLen = rows.length;
  return {
    generated_at: data.generated_at ?? null,
    notes: data.notes ?? null,
    gaps: rows,
    total: page.total ?? rowLen,
    returned: page.returned ?? rowLen,
    limit: page.limit ?? rowLen,
    cursor: page.cursor ?? 0,
    next_cursor: page.next_cursor ?? null,
    sort: page.sort ?? null,
    order: page.order ?? null,
  };
}

export const LIST_GAPS_INSTRUCTIONS =
  "list_gaps per-subnet interface gap reports (missing facets, gap_count; " +
  "mirrors GET /api/v1/gaps), ";

export const LIST_GAPS_MCP_TOOL = {
  name: "list_gaps",
  title: "List subnet interface gaps",
  description:
    "Fetch per-subnet interface gap reports from the registry: missing or " +
    "unsupported public interface facets, gap_count, coverage_level, and " +
    "curation_level for every active subnet. Filter by netuid, coverage_level, " +
    "or curation_level, sort with sort + order, and page with limit (1-100) / " +
    "cursor. Use get_subnet_gaps for one subnet's contributor enrichment queue. " +
    "Mirrors GET /api/v1/gaps.",
  inputSchema: z.toJSONSchema(ListGapsInputSchema, {
    target: "draft-2020-12",
  }),
};

export const LIST_GAPS_OUTPUT_SCHEMA = z.toJSONSchema(ListGapsOutputSchema, {
  target: "draft-2020-12",
});
