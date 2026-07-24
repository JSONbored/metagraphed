// Global incident list-query helper for MCP parity on GET /api/v1/incidents.
// Builds the netuid/limit/cursor/sort/order query the REST route accepts on
// top of its own `window` scope, then applies the same list-query transform
// handleGlobalIncidents runs over the `surfaces` ledger -- mirrors
// endpoint-incidents-mcp.ts's query-builder + list-application pattern.

import { applyQueryFilters, type Row } from "../workers/list-query.ts";
import { API_QUERY_COLLECTIONS } from "./contracts.ts";

export const GLOBAL_INCIDENTS_SORT_FIELDS =
  API_QUERY_COLLECTIONS["incidents"].sort_fields;

export interface GlobalIncidentsMcpError extends Error {
  toolError: true;
  code: string;
}

export function globalIncidentsMcpError(
  code: string,
  message: string,
): GlobalIncidentsMcpError {
  const error = new Error(message) as GlobalIncidentsMcpError;
  error.toolError = true;
  error.code = code;
  return error;
}

function optionalEnum(
  args: Record<string, unknown> | null | undefined,
  key: string,
  allowed: string[],
): string | null {
  const value = args?.[key];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw globalIncidentsMcpError(
      "invalid_params",
      `Argument \`${key}\` must be one of: ${allowed.join(", ")}.`,
    );
  }
  return value;
}

export function globalIncidentsQueryUrl(
  args: Record<string, unknown> | null | undefined,
): URL {
  const url = new URL("https://mcp.internal/incidents");
  if (args?.netuid !== undefined) {
    const netuid = args.netuid;
    if (typeof netuid !== "number" || !Number.isInteger(netuid) || netuid < 0) {
      throw globalIncidentsMcpError(
        "invalid_params",
        "netuid must be a non-negative integer.",
      );
    }
    url.searchParams.set("netuid", String(netuid));
  }
  const sort = optionalEnum(args, "sort", GLOBAL_INCIDENTS_SORT_FIELDS);
  if (sort) url.searchParams.set("sort", sort);
  const order = optionalEnum(args, "order", ["asc", "desc"]);
  if (order) url.searchParams.set("order", order);
  if (args?.limit !== undefined) {
    const limit = args.limit;
    if (
      typeof limit !== "number" ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      throw globalIncidentsMcpError(
        "invalid_params",
        "limit must be an integer between 1 and 100.",
      );
    }
    url.searchParams.set("limit", String(limit));
  }
  if (args?.cursor !== undefined) {
    const cursor = args.cursor;
    if (typeof cursor !== "number" || !Number.isInteger(cursor) || cursor < 0) {
      throw globalIncidentsMcpError(
        "invalid_params",
        "cursor must be a non-negative integer.",
      );
    }
    url.searchParams.set("cursor", String(cursor));
  }
  return url;
}

export type GlobalIncidentsListResult = Record<string, unknown> & {
  surfaces: Row[];
  total: unknown;
  returned: unknown;
  limit: unknown;
  cursor: unknown;
  next_cursor: unknown;
  sort: unknown;
  order: unknown;
};

// Spreads `out` rather than reconstructing a fixed field set: the tier-wiring
// tests (mcp-server.test.ts) assert arbitrary Postgres-tier response fields
// (e.g. a `marker` probe) round-trip verbatim, the same contract every other
// get_* tool's Postgres-tier passthrough honors.
export function applyGlobalIncidentsListQuery(
  data: Record<string, unknown>,
  args: Record<string, unknown> | null | undefined,
): GlobalIncidentsListResult {
  const queryUrl = globalIncidentsQueryUrl(args);
  const transformed = applyQueryFilters(data, queryUrl, "incidents");
  if (transformed.error) {
    throw globalIncidentsMcpError("invalid_params", transformed.error.message);
  }
  const out = transformed.data as Record<string, unknown>;
  const meta = transformed.meta as Record<string, unknown>;
  const page = (meta.pagination as Record<string, unknown>) || {};
  const rows = Array.isArray(out.surfaces) ? (out.surfaces as Row[]) : [];
  const rowLen = rows.length;
  return {
    ...out,
    surfaces: rows,
    total: page.total ?? rowLen,
    returned: page.returned ?? rowLen,
    limit: page.limit ?? rowLen,
    cursor: page.cursor ?? 0,
    next_cursor: page.next_cursor ?? null,
    sort: page.sort ?? null,
    order: page.order ?? null,
  };
}
