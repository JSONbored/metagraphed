// Per-subnet health list loader for MCP parity on
// GET /api/v1/subnets/{netuid}/health (#7901). Applies the same list-query
// transforms as the REST route over the live-only health overlay -- this
// route is live-only by design (workers/api.ts's liveHealthOverlay never
// reads a static artifact for "subnet-health"; it serves an explicit
// "unknown" payload on a cold snapshot instead), so there is no artifact
// read step here, unlike the sibling subnet-endpoints-mcp.ts.

import { applyQueryFilters, type Row } from "../workers/list-query.ts";
import { API_QUERY_COLLECTIONS, QUERY_ENUMS } from "./contracts.ts";
import { overlaySubnetHealth, resolveLiveHealth } from "./health-serving.ts";

const HEALTH_SORT_FIELDS = API_QUERY_COLLECTIONS["health-surfaces"].sort_fields;
const SURFACE_KINDS = QUERY_ENUMS.surfaceKind;
const HEALTH_STATUSES = QUERY_ENUMS.healthStatus;
const HEALTH_CLASSIFICATIONS = QUERY_ENUMS.healthClassification;
// netuid selects the per-subnet snapshot (not a row filter here — the REST
// route excludes it the same way, listQuery("health-surfaces", { exclude:
// ["netuid"] }) in src/contracts.ts), so it's kept out of the filter names
// passed to applyQueryFilters even though the shared "health-surfaces"
// collection declares it as a general filter.
const SUBNET_HEALTH_QUERY_FILTER_NAMES = [
  "kind",
  "provider",
  "status",
  "classification",
];

export interface SubnetHealthMcpError extends Error {
  toolError: true;
  code: string;
}

export function subnetHealthMcpError(
  code: string,
  message: string,
): SubnetHealthMcpError {
  const error = new Error(message) as SubnetHealthMcpError;
  error.toolError = true;
  error.code = code;
  return error;
}

function requireNetuid(
  args: Record<string, unknown> | null | undefined,
): number {
  const netuid = args?.netuid;
  if (typeof netuid !== "number" || !Number.isInteger(netuid) || netuid < 0) {
    throw subnetHealthMcpError(
      "invalid_params",
      "netuid must be a non-negative integer.",
    );
  }
  return netuid;
}

function optionalString(
  args: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const value = args?.[key];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim() === "") {
    throw subnetHealthMcpError(
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
    throw subnetHealthMcpError(
      "invalid_params",
      `Argument \`${key}\` must be one of: ${allowed.join(", ")}.`,
    );
  }
  return value;
}

export function subnetHealthQueryUrl(
  args: Record<string, unknown> | null | undefined,
): URL {
  const url = new URL("https://mcp.internal/subnets/health");
  requireNetuid(args);
  const kind = optionalEnum(args, "kind", SURFACE_KINDS);
  if (kind) url.searchParams.set("kind", kind);
  const provider = optionalString(args, "provider");
  if (provider) url.searchParams.set("provider", provider);
  const status = optionalEnum(args, "status", HEALTH_STATUSES);
  if (status) url.searchParams.set("status", status);
  const classification = optionalEnum(
    args,
    "classification",
    HEALTH_CLASSIFICATIONS,
  );
  if (classification) {
    url.searchParams.set("classification", classification);
  }
  const sort = optionalEnum(args, "sort", HEALTH_SORT_FIELDS);
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
      throw subnetHealthMcpError(
        "invalid_params",
        "limit must be an integer between 1 and 100.",
      );
    }
    url.searchParams.set("limit", String(limit));
  }
  if (args?.cursor !== undefined) {
    const cursor = args.cursor;
    if (typeof cursor !== "number" || !Number.isInteger(cursor) || cursor < 0) {
      throw subnetHealthMcpError(
        "invalid_params",
        "cursor must be a non-negative integer.",
      );
    }
    url.searchParams.set("cursor", String(cursor));
  }
  return url;
}

interface SubnetHealthMcpCtx {
  env: Env;
  readHealthKv?: (
    env: Env,
    key: string,
  ) => Promise<Record<string, unknown> | null>;
}

export interface SubnetHealthListResult {
  netuid: unknown;
  summary: unknown;
  operational_observed_at: unknown;
  health_source: unknown;
  surfaces: Row[];
  total: unknown;
  returned: unknown;
  limit: unknown;
  cursor: unknown;
  next_cursor: unknown;
  sort: unknown;
  order: unknown;
}

// unknown/cold-snapshot fallback shape, matching get_subnet_health's own
// (src/mcp-server.ts) so the two tools agree on what "no live data" looks
// like.
function unknownSubnetHealth(netuid: number): Row {
  return {
    schema_version: 1,
    netuid,
    summary: { status: "unknown", surface_count: 0 },
    operational_observed_at: null,
    health_source: "unavailable",
    surfaces: [],
  };
}

export async function loadSubnetHealthList(
  ctx: SubnetHealthMcpCtx,
  args: Record<string, unknown> | null | undefined,
  {
    resolveLiveHealth: resolveLiveHealthDep,
  }: {
    resolveLiveHealth?: typeof resolveLiveHealth;
  } = {},
): Promise<SubnetHealthListResult> {
  const netuid = requireNetuid(args);
  const queryUrl = subnetHealthQueryUrl(args);
  const resolve = resolveLiveHealthDep ?? resolveLiveHealth;
  const live = await resolve({
    readHealthKv: ctx.readHealthKv,
    env: ctx.env,
  });
  const overlaid = overlaySubnetHealth(null, live, netuid);
  const data = overlaid ?? unknownSubnetHealth(netuid);

  const transformed = applyQueryFilters(
    data,
    queryUrl,
    "health-surfaces",
    SUBNET_HEALTH_QUERY_FILTER_NAMES,
  );
  if (transformed.error) {
    throw subnetHealthMcpError("invalid_params", transformed.error.message);
  }
  const result = transformed.data as Record<string, unknown>;
  const meta = transformed.meta as Record<string, unknown>;
  const page = (meta.pagination as Record<string, unknown>) || {};
  const rows = Array.isArray(result.surfaces) ? (result.surfaces as Row[]) : [];
  const rowLen = rows.length;
  return {
    netuid: result.netuid ?? netuid,
    summary: result.summary ?? null,
    operational_observed_at: result.operational_observed_at ?? null,
    health_source: result.health_source ?? null,
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

export const LIST_SUBNET_HEALTH_INSTRUCTIONS =
  "list_subnet_health one subnet's live per-surface health rows with REST " +
  "list-query filters (kind, provider, status, classification, sort, order, " +
  "pagination; mirrors GET /api/v1/subnets/{netuid}/health), ";

export const LIST_SUBNET_HEALTH_MCP_TOOL = {
  name: "list_subnet_health",
  title: "List one subnet's live health records",
  description:
    "Fetch live operational health for one subnet's surfaces (probed every " +
    "~15 minutes): per-surface status, classification, latency, and last-ok " +
    "timestamp. Filter by kind, provider, status, or classification; sort " +
    "with sort + order; and page with limit (1-100) / cursor. Distinct from " +
    "get_subnet_health (unfiltered current snapshot). Mirrors " +
    "GET /api/v1/subnets/{netuid}/health.",
  inputSchema: {
    type: "object",
    properties: {
      netuid: { type: "integer", description: "Subnet netuid.", minimum: 0 },
      kind: {
        type: "string",
        enum: SURFACE_KINDS,
        description: "Filter by surface kind, e.g. 'subnet-api'.",
      },
      provider: {
        type: "string",
        description: "Filter by provider slug.",
      },
      status: {
        type: "string",
        enum: HEALTH_STATUSES,
        description: "Filter by probe-derived health status.",
      },
      classification: {
        type: "string",
        enum: HEALTH_CLASSIFICATIONS,
        description: "Filter by probe-derived health classification.",
      },
      sort: {
        type: "string",
        enum: HEALTH_SORT_FIELDS,
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
          "Comma-separated projection of surface row fields to return.",
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
    required: ["netuid"],
    additionalProperties: false,
  },
};

const NULLABLE_STRING = { type: ["string", "null"] };
const NULLABLE_INT = { type: ["integer", "null"] };

export const LIST_SUBNET_HEALTH_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: ["netuid", "surfaces"],
  properties: {
    netuid: { type: "integer" },
    summary: { type: "object" },
    operational_observed_at: NULLABLE_STRING,
    health_source: NULLABLE_STRING,
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
