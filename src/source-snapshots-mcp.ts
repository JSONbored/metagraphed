// Source snapshots list loader for MCP parity on GET /api/v1/source-snapshots.
// Applies the same list-query transforms as the REST route over the baked
// /metagraph/source-snapshots.json artifact.

import { applyQueryFilters, type Row } from "../workers/list-query.ts";
import type { StorageReadResult } from "../workers/storage.ts";
import { API_QUERY_COLLECTIONS } from "./contracts.ts";

export const SOURCE_SNAPSHOTS_ARTIFACT = "/metagraph/source-snapshots.json";

const SOURCE_SORT_FIELDS = API_QUERY_COLLECTIONS.sources.sort_fields;

export interface SourceSnapshotsMcpError extends Error {
  toolError: true;
  code: string;
}

export function sourceSnapshotsMcpError(
  code: string,
  message: string,
): SourceSnapshotsMcpError {
  const error = new Error(message) as SourceSnapshotsMcpError;
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
    throw sourceSnapshotsMcpError(
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
    throw sourceSnapshotsMcpError(
      "invalid_params",
      `Argument \`${key}\` must be one of: ${allowed.join(", ")}.`,
    );
  }
  return value;
}

export function sourceSnapshotsQueryUrl(
  args: Record<string, unknown> | null | undefined,
): URL {
  const url = new URL("https://mcp.internal/source-snapshots");
  const q = optionalString(args, "q");
  if (q) url.searchParams.set("q", q);
  const sort = optionalEnum(args, "sort", SOURCE_SORT_FIELDS);
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
      throw sourceSnapshotsMcpError(
        "invalid_params",
        "limit must be an integer between 1 and 100.",
      );
    }
    url.searchParams.set("limit", String(limit));
  }
  if (args?.cursor !== undefined) {
    const cursor = args.cursor;
    if (typeof cursor !== "number" || !Number.isInteger(cursor) || cursor < 0) {
      throw sourceSnapshotsMcpError(
        "invalid_params",
        "cursor must be a non-negative integer.",
      );
    }
    url.searchParams.set("cursor", String(cursor));
  }
  return url;
}

export interface SourceSnapshotsListResult {
  generated_at: unknown;
  schema_version: unknown;
  summary: unknown;
  sources: Row[];
  total: unknown;
  returned: unknown;
  limit: unknown;
  cursor: unknown;
  next_cursor: unknown;
  sort: unknown;
  order: unknown;
}

export async function loadSourceSnapshotsList(
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
): Promise<SourceSnapshotsListResult> {
  const queryUrl = sourceSnapshotsQueryUrl(args);
  const read = readArtifact ?? ctx.readArtifact;
  const result = await read(ctx.env, SOURCE_SNAPSHOTS_ARTIFACT);
  if (!result?.ok) {
    const code =
      (result as { code?: string } | undefined)?.code || "artifact_unavailable";
    if (code === "artifact_not_found") {
      throw sourceSnapshotsMcpError(
        "not_found",
        "Source snapshots ledger unavailable.",
      );
    }
    throw sourceSnapshotsMcpError(
      code,
      `Could not load ${SOURCE_SNAPSHOTS_ARTIFACT} (${code}).`,
    );
  }
  const blob = result.data;
  if (!blob || typeof blob !== "object") {
    throw sourceSnapshotsMcpError(
      "not_found",
      "Source snapshots ledger unavailable.",
    );
  }
  const transformed = applyQueryFilters(
    blob as Record<string, unknown>,
    queryUrl,
    "sources",
    [],
  );
  if (transformed.error) {
    throw sourceSnapshotsMcpError("invalid_params", transformed.error.message);
  }
  const data = transformed.data as Record<string, unknown>;
  const meta = transformed.meta as Record<string, unknown>;
  const page = (meta.pagination as Record<string, unknown>) || {};
  const rows = Array.isArray(data.sources) ? (data.sources as Row[]) : [];
  const rowLen = rows.length;
  return {
    generated_at: data.generated_at ?? null,
    schema_version: data.schema_version ?? null,
    summary: data.summary ?? null,
    sources: rows,
    total: page.total ?? rowLen,
    returned: page.returned ?? rowLen,
    limit: page.limit ?? rowLen,
    cursor: page.cursor ?? 0,
    next_cursor: page.next_cursor ?? null,
    sort: page.sort ?? null,
    order: page.order ?? null,
  };
}

export const LIST_SOURCE_SNAPSHOTS_INSTRUCTIONS =
  "Use list_source_snapshots to page the per-source input-hash ledger " +
  "(mirrors GET /api/v1/source-snapshots), ";

export const LIST_SOURCE_SNAPSHOTS_MCP_TOOL = {
  name: "list_source_snapshots",
  title: "List source input snapshots",
  description:
    "Fetch the source-snapshot ledger: the per-source input hash and record " +
    "count captured for each registry data source at ingest time. Filter with " +
    "q, sort with sort + order, project with fields, and page with limit " +
    "(1-100) / cursor. Use it to detect when a source's underlying data " +
    "changed (hash drift) or to see how many records each source contributed. " +
    "Mirrors GET /api/v1/source-snapshots.",
  inputSchema: {
    type: "object",
    properties: {
      q: {
        type: "string",
        description: "Keyword search across source id, kind, and path.",
      },
      sort: {
        type: "string",
        enum: SOURCE_SORT_FIELDS,
        description: "Field to sort by before paging.",
      },
      order: {
        type: "string",
        enum: ["asc", "desc"],
        description: "Sort direction for sort (default asc).",
      },
      fields: {
        type: "string",
        description: "Comma-separated projection of source fields to return.",
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

export const LIST_SOURCE_SNAPSHOTS_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: ["sources"],
  properties: {
    generated_at: NULLABLE_STRING,
    schema_version: { type: ["string", "integer", "null"] },
    summary: { type: ["object", "null"] },
    sources: { type: "array", items: { type: "object" } },
    total: { type: "integer" },
    returned: { type: "integer" },
    limit: { type: "integer" },
    cursor: { type: "integer" },
    next_cursor: NULLABLE_INT,
    sort: NULLABLE_STRING,
    order: NULLABLE_STRING,
  },
};
