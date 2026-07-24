// Per-subnet health-surface list loader for MCP parity on
// GET /api/v1/subnets/{netuid}/health. Applies the same list-query
// transforms as the REST route over the baked
// /metagraph/health/subnets/{netuid}.json artifact.

import { applyQueryFilters, type Row } from "../workers/list-query.ts";
import type { StorageReadResult } from "../workers/storage.ts";
import { API_QUERY_COLLECTIONS, QUERY_ENUMS } from "./contracts.ts";

const HEALTH_SORT_FIELDS = API_QUERY_COLLECTIONS["health-surfaces"].sort_fields;
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
  const sort = optionalEnum(args, "sort", HEALTH_SORT_FIELDS);
  if (sort) url.searchParams.set("sort", sort);
  const order = optionalEnum(args, "order", ["asc", "desc"]);
  if (order) url.searchParams.set("order", order);
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
  netuid: unknown;
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
    readArtifact: (env: Env, path: string) => Promise<StorageReadResult>;
  },
  args: Record<string, unknown> | null | undefined,
  {
    readArtifact,
  }: {
    readArtifact?: (env: Env, path: string) => Promise<StorageReadResult>;
  } = {},
): Promise<SubnetHealthListResult> {
  const netuid = requireNetuid(args);
  const queryUrl = subnetHealthQueryUrl(args);
  const artifactPath = subnetHealthArtifactPath(netuid);
  const read = readArtifact ?? ctx.readArtifact;
  const result = await read(ctx.env, artifactPath);
  if (!result?.ok) {
    const code =
      (result as { code?: string } | undefined)?.code || "artifact_unavailable";
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
  const blob = result.data;
  if (!blob || typeof blob !== "object") {
    throw subnetHealthMcpError(
      "not_found",
      `No health snapshot exists for netuid ${netuid}.`,
    );
  }
  const transformed = applyQueryFilters(
    blob as Record<string, unknown>,
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
    netuid: data.netuid ?? netuid,
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
  "list_subnet_health one subnet's per-surface health records with REST " +
  "list-query filters (kind, provider, status, classification, sort/order, and " +
  "pagination; mirrors GET /api/v1/subnets/{netuid}/health), ";

export const LIST_SUBNET_HEALTH_MCP_TOOL = {
  name: "list_subnet_health",
  title: "List one subnet's per-surface health",
  description:
    "Fetch per-surface health records for one subnet by netuid: each monitored " +
    "surface with its kind, provider, probe-derived status and classification, " +
    "latency, and last-checked/last-ok times. Filter by kind, provider, status, " +
    "or classification; sort with sort + order; and page with limit (1-100) / " +
    "cursor. The filtered sibling of get_subnet_health (raw artifact dump). " +
    "Mirrors GET /api/v1/subnets/{netuid}/health.",
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
        description: "Filter by probe-derived reachability classification.",
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
    netuid: NULLABLE_INT,
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
