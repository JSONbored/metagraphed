// Per-subnet health surfaces list loader for MCP parity on
// GET /api/v1/subnets/{netuid}/health. Applies the same list-query
// transforms as the REST route over the live per-subnet health card
// (or a test-injected snapshot at the retired
// /metagraph/health/subnets/{netuid}.json path).

import { applyQueryFilters, type Row } from "../workers/list-query.ts";
import type { StorageReadResult } from "../workers/storage.ts";
import { API_QUERY_COLLECTIONS, QUERY_ENUMS } from "./contracts.ts";
import { overlaySubnetHealth, resolveLiveHealth } from "./health-serving.ts";

const HEALTH_SURFACE_SORT_FIELDS =
  API_QUERY_COLLECTIONS["health-surfaces"].sort_fields;
const SURFACE_KINDS = QUERY_ENUMS.surfaceKind;
const HEALTH_STATUSES = QUERY_ENUMS.healthStatus;
const HEALTH_CLASSIFICATIONS = QUERY_ENUMS.healthClassification;
const SUBNET_HEALTH_QUERY_FILTER_NAMES = [
  "kind",
  "provider",
  "status",
  "classification",
];

export function subnetHealthArtifactPath(netuid: unknown): string {
  return `/metagraph/health/subnets/${netuid}.json`;
}

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

function clampLimit(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number") return fallback;
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.min(max, Math.floor(value));
}

function unknownSubnetHealthCard(netuid: number): Record<string, unknown> {
  return {
    schema_version: 1,
    netuid,
    summary: {
      status: "unknown",
      surface_count: 0,
      ok_count: 0,
      degraded_count: 0,
      failed_count: 0,
      unknown_count: 0,
      last_checked: null,
      last_ok: null,
      avg_latency_ms: null,
    },
    operational_observed_at: null,
    health_source: "unavailable",
    surfaces: [],
  };
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
  if (classification) url.searchParams.set("classification", classification);
  const sort = optionalEnum(args, "sort", HEALTH_SURFACE_SORT_FIELDS);
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
      throw subnetHealthMcpError(
        "invalid_params",
        "cursor must be a non-negative integer.",
      );
    }
    url.searchParams.set("cursor", String(cursor));
  }
  return url;
}

export interface SubnetHealthListResult {
  generated_at: unknown;
  schema_version: unknown;
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

export async function loadSubnetHealthList(
  ctx: {
    env: Env;
    readArtifact?: (env: Env, path: string) => Promise<StorageReadResult>;
    readHealthKv?: (
      env: Env,
      key: string,
    ) => Promise<Record<string, unknown> | null>;
  },
  args: Record<string, unknown> | null | undefined,
  {
    readArtifact,
    resolveLiveHealth: resolveLive,
    overlaySubnetHealth: overlay,
  }: {
    readArtifact?: (env: Env, path: string) => Promise<StorageReadResult>;
    resolveLiveHealth?: typeof resolveLiveHealth;
    overlaySubnetHealth?: typeof overlaySubnetHealth;
  } = {},
): Promise<SubnetHealthListResult> {
  const netuid = requireNetuid(args);
  const queryUrl = subnetHealthQueryUrl(args);
  const artifactPath = subnetHealthArtifactPath(netuid);

  let blob: Record<string, unknown>;

  // Endpoints-shaped injection path: unit tests pass a surfaces-bearing
  // snapshot via readArtifact (retired artifact path). Production leaves
  // this unset and uses the live overlay below (REST parity).
  if (readArtifact) {
    const result = await readArtifact(ctx.env, artifactPath);
    if (!result?.ok) {
      const code =
        (result as { code?: string } | undefined)?.code ||
        "artifact_unavailable";
      if (code === "artifact_not_found") {
        throw subnetHealthMcpError(
          "not_found",
          `No health snapshot exists for netuid ${netuid}.`,
        );
      }
      throw subnetHealthMcpError(
        code,
        `Could not load ${artifactPath} (${code}).`,
      );
    }
    const data = result.data;
    if (!data || typeof data !== "object") {
      throw subnetHealthMcpError(
        "not_found",
        `No health snapshot exists for netuid ${netuid}.`,
      );
    }
    blob = data as Record<string, unknown>;
  } else {
    const resolve = resolveLive ?? resolveLiveHealth;
    const overlayFn = overlay ?? overlaySubnetHealth;
    const live = await resolve({
      readHealthKv: ctx.readHealthKv,
      env: ctx.env,
    });
    blob =
      (overlayFn(null, live, netuid) as Record<string, unknown> | null) ??
      unknownSubnetHealthCard(netuid);
  }

  const transformed = applyQueryFilters(
    blob,
    queryUrl,
    "health-surfaces",
    SUBNET_HEALTH_QUERY_FILTER_NAMES,
  );
  if (transformed.error) {
    throw subnetHealthMcpError("invalid_params", transformed.error.message);
  }
  const data = transformed.data as Record<string, unknown>;
  const meta = transformed.meta as Record<string, unknown>;
  const page = (meta.pagination as Record<string, unknown>) || {};
  const rows = Array.isArray(data.surfaces) ? (data.surfaces as Row[]) : [];
  const rowLen = rows.length;
  return {
    generated_at: data.generated_at ?? null,
    schema_version: data.schema_version ?? null,
    netuid: data.netuid ?? netuid,
    summary: data.summary ?? null,
    operational_observed_at: data.operational_observed_at ?? null,
    health_source: data.health_source ?? null,
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
  "list_subnet_health one subnet's live health surfaces with REST list-query " +
  "filters (kind, provider, status, classification, sort, and pagination; " +
  "mirrors GET /api/v1/subnets/{netuid}/health), ";

export const LIST_SUBNET_HEALTH_MCP_TOOL = {
  name: "list_subnet_health",
  title: "List one subnet's health surfaces",
  description:
    "Fetch live operational health surfaces for one subnet by netuid: each " +
    "surface with kind, provider, probe-derived status, classification, " +
    "latency, and last-ok timestamps. Filter by kind, provider, status, or " +
    "classification; sort with sort + order; project with fields; and page " +
    "with limit (1-100) / cursor. Distinct from get_subnet_health (unfiltered " +
    "live card) and get_network_health (global rollup). Mirrors " +
    "GET /api/v1/subnets/{netuid}/health.",
  inputSchema: {
    type: "object",
    properties: {
      netuid: {
        type: "integer",
        description: "Subnet netuid.",
        minimum: 0,
      },
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
        description: "Filter by probe classification.",
      },
      sort: {
        type: "string",
        enum: HEALTH_SURFACE_SORT_FIELDS,
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
          "Comma-separated projection of health surface row fields to return.",
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
  required: ["surfaces"],
  properties: {
    generated_at: NULLABLE_STRING,
    schema_version: { type: ["string", "integer", "null"] },
    netuid: NULLABLE_INT,
    summary: { type: ["object", "null"] },
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
