// Daily health-history loader for REST + MCP parity on
// GET /api/v1/health/history/{date}. Artifact-backed list-query over dated
// health/history snapshots with health-surfaces filters.

import { DAY_PATTERN } from "../workers/request-params.ts";
import { applyQueryFilters, type Row } from "../workers/list-query.ts";
import { API_QUERY_COLLECTIONS, QUERY_ENUMS } from "./contracts.mjs";

const HEALTH_SURFACE_SORT_FIELDS =
  API_QUERY_COLLECTIONS["health-surfaces"].sort_fields;
const NULLABLE_STRING = { type: ["string", "null"] };
const NULLABLE_INT = { type: ["integer", "null"] };

export interface HealthHistoryMcpError extends Error {
  healthHistoryMcp: true;
  code: string;
}

export function healthHistoryMcpError(
  code: string,
  message: string,
): HealthHistoryMcpError {
  const err = new Error(message) as HealthHistoryMcpError;
  err.code = code;
  err.healthHistoryMcp = true;
  return err;
}

function requireDate(date: unknown): string {
  if (typeof date !== "string" || !DAY_PATTERN.test(date.trim())) {
    throw healthHistoryMcpError(
      "invalid_params",
      "date must be a YYYY-MM-DD day.",
    );
  }
  return date.trim();
}

function optionalString(
  args: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const value = args?.[key];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim() === "") {
    throw healthHistoryMcpError(
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
    throw healthHistoryMcpError(
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

export function healthHistoryQueryUrl(
  args: Record<string, unknown> | null | undefined,
): URL {
  const url = new URL("https://mcp.internal/health-history");
  if (args?.netuid !== undefined) {
    const netuid = args.netuid;
    if (typeof netuid !== "number" || !Number.isInteger(netuid) || netuid < 0) {
      throw healthHistoryMcpError(
        "invalid_params",
        "netuid must be a non-negative integer.",
      );
    }
    url.searchParams.set("netuid", String(netuid));
  }
  const kind = optionalEnum(args, "kind", QUERY_ENUMS.surfaceKind);
  if (kind) url.searchParams.set("kind", kind);
  const provider = optionalString(args, "provider");
  if (provider) url.searchParams.set("provider", provider);
  const status = optionalEnum(args, "status", QUERY_ENUMS.healthStatus);
  if (status) url.searchParams.set("status", status);
  const classification = optionalEnum(
    args,
    "classification",
    QUERY_ENUMS.healthClassification,
  );
  if (classification) url.searchParams.set("classification", classification);
  const sort = optionalEnum(args, "sort", HEALTH_SURFACE_SORT_FIELDS);
  if (sort) url.searchParams.set("sort", sort);
  const order = optionalEnum(args, "order", ["asc", "desc"]);
  if (order) url.searchParams.set("order", order);
  const fields = optionalString(args, "fields");
  if (fields) url.searchParams.set("fields", fields);
  if (args?.limit !== undefined) {
    url.searchParams.set("limit", String(clampLimit(args.limit, 100, 1000)));
  }
  if (args?.cursor !== undefined) {
    const cursor = args.cursor;
    if (typeof cursor !== "number" || !Number.isInteger(cursor) || cursor < 0) {
      throw healthHistoryMcpError(
        "invalid_params",
        "cursor must be a non-negative integer.",
      );
    }
    url.searchParams.set("cursor", String(cursor));
  }
  return url;
}

export interface HealthHistoryResult {
  date: unknown;
  summary: unknown;
  surfaces: Row[];
  total: unknown;
  returned: unknown;
  limit: unknown;
  cursor: unknown;
  next_cursor: unknown;
  sort: unknown;
  order: unknown;
}

export async function loadHealthHistory(
  ctx: unknown,
  args: Record<string, unknown> | null | undefined,
  deps: {
    readArtifact: (ctx: unknown, artifactPath: string) => Promise<unknown>;
  },
): Promise<HealthHistoryResult> {
  const date = requireDate(args?.date);
  const queryUrl = healthHistoryQueryUrl(args);
  const blob = await deps.readArtifact(
    ctx,
    `/metagraph/health/history/${date}.json`,
  );
  if (!blob || typeof blob !== "object") {
    throw healthHistoryMcpError(
      "not_found",
      `No health-history snapshot for ${date}.`,
    );
  }
  const transformed = applyQueryFilters(
    blob as Record<string, unknown>,
    queryUrl,
    "health-surfaces",
    [],
  );
  if (transformed.error) {
    throw healthHistoryMcpError("invalid_params", transformed.error.message);
  }
  const data = transformed.data as Record<string, unknown>;
  const meta = transformed.meta as Record<string, unknown>;
  const page = (meta.pagination as Record<string, unknown>) || {};
  const surfaces = Array.isArray(data.surfaces) ? (data.surfaces as Row[]) : [];
  const surfaceLen = surfaces.length;
  return {
    date: data.date ?? date,
    summary: data.summary ?? null,
    surfaces,
    total: page.total ?? surfaceLen,
    returned: page.returned ?? surfaceLen,
    limit: page.limit ?? surfaceLen,
    cursor: page.cursor ?? 0,
    next_cursor: page.next_cursor ?? null,
    sort: page.sort ?? null,
    order: page.order ?? null,
  };
}

export const GET_HEALTH_HISTORY_INSTRUCTIONS =
  "get_health_history a dated operational health snapshot (filterable surfaces), ";

export const GET_HEALTH_HISTORY_MCP_TOOL = {
  name: "get_health_history",
  title: "Get daily operational health history",
  description:
    "Fetch a compact daily operational health snapshot for one UTC date: " +
    "per-surface status, latency, and summary incident counts from the archived " +
    "health/history tier. Filter by netuid, kind, provider, status, or " +
    "classification; sort with sort + order; page with limit (1-1000) / cursor. " +
    "Use get_network_health for the live rollup and get_health_trends for the " +
    "7d/30d matrix. Mirrors GET /api/v1/health/history/{date}.",
  inputSchema: {
    type: "object",
    properties: {
      date: {
        type: "string",
        description: "UTC snapshot date inclusive, YYYY-MM-DD.",
        pattern: "^\\d{4}-\\d{2}-\\d{2}$",
      },
      netuid: {
        type: "integer",
        description: "Filter to one subnet netuid.",
        minimum: 0,
      },
      kind: {
        type: "string",
        enum: QUERY_ENUMS.surfaceKind,
        description: "Filter by surface kind.",
      },
      provider: {
        type: "string",
        description: "Filter by provider slug.",
      },
      status: {
        type: "string",
        enum: QUERY_ENUMS.healthStatus,
        description: "Filter by probe status.",
      },
      classification: {
        type: "string",
        enum: QUERY_ENUMS.healthClassification,
        description: "Filter by health classification.",
      },
      sort: {
        type: "string",
        enum: HEALTH_SURFACE_SORT_FIELDS,
        description:
          "Field to sort by (bare name only). Pair with order for direction.",
      },
      order: {
        type: "string",
        enum: ["asc", "desc"],
        description: "Sort direction for sort (default asc).",
      },
      fields: {
        type: "string",
        description:
          "Comma-separated projection of surface row fields to return.",
      },
      limit: {
        type: "integer",
        description: "Max surface rows to return (1-1000). Enables pagination.",
        minimum: 1,
        maximum: 1000,
      },
      cursor: {
        type: "integer",
        description: "Pagination cursor from a prior response's next_cursor.",
        minimum: 0,
      },
    },
    required: ["date"],
    additionalProperties: false,
  },
};

export const GET_HEALTH_HISTORY_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: ["date", "surfaces"],
  properties: {
    date: NULLABLE_STRING,
    summary: { type: ["object", "null"] },
    surfaces: { type: "array", items: { type: "object" } },
    total: { type: "integer" },
    returned: { type: "integer" },
    limit: { type: "integer" },
    cursor: { type: "integer" },
    next_cursor: NULLABLE_INT,
    sort: NULLABLE_STRING,
    order: NULLABLE_STRING,
  },
};
