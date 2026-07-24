// Per-subnet gaps loader for GraphQL/REST parity on
// GET /api/v1/subnets/{netuid}/gaps. Applies the same list-query transforms as
// the REST route over the baked /metagraph/review/gaps/{netuid}.json artifact
// (review-gap-priorities collection, netuid already scoped by path). Structurally
// mirrors review-gaps-mcp.ts (network-wide sibling) and subnet-endpoints-mcp.ts.

import { applyQueryFilters, type Row } from "../workers/list-query.ts";
import type { StorageReadResult } from "../workers/storage.ts";
import { API_QUERY_COLLECTIONS, QUERY_ENUMS } from "./contracts.ts";

const PRIORITY_SORT_FIELDS =
  API_QUERY_COLLECTIONS["review-gap-priorities"].sort_fields;
const CURATION_LEVELS = QUERY_ENUMS.curationLevel;
const SURFACE_KINDS = QUERY_ENUMS.surfaceKind;

export function subnetGapsArtifactPath(netuid: number): string {
  return `/metagraph/review/gaps/${netuid}.json`;
}

export interface SubnetGapsMcpError extends Error {
  toolError: true;
  code: string;
}

export function subnetGapsMcpError(
  code: string,
  message: string,
): SubnetGapsMcpError {
  const error = new Error(message) as SubnetGapsMcpError;
  error.toolError = true;
  error.code = code;
  return error;
}

export function requireSubnetGapsNetuid(
  args: Record<string, unknown> | null | undefined,
): number {
  const netuid = args?.netuid;
  if (typeof netuid !== "number" || !Number.isInteger(netuid) || netuid < 0) {
    throw subnetGapsMcpError(
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
    throw subnetGapsMcpError(
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
    throw subnetGapsMcpError(
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

function resolveMissingKinds(
  args: Record<string, unknown> | null | undefined,
): string | null {
  const value = args?.missing_kinds;
  if (value === undefined || value === null || value === "") return null;
  if (Array.isArray(value)) {
    const kinds = value
      .filter((part): part is string => typeof part === "string")
      .map((part) => part.trim())
      .filter(Boolean);
    if (kinds.length === 0) {
      throw subnetGapsMcpError(
        "invalid_params",
        "Argument `missing_kinds` must be a non-empty list of surface kinds when provided.",
      );
    }
    for (const kind of kinds) {
      if (!SURFACE_KINDS.includes(kind)) {
        throw subnetGapsMcpError(
          "invalid_params",
          `Argument \`missing_kinds\` must be one of: ${SURFACE_KINDS.join(", ")}.`,
        );
      }
    }
    // REST accepts a single missing_kinds enum; use the first requested kind.
    return kinds[0];
  }
  return optionalEnum(args, "missing_kinds", SURFACE_KINDS);
}

function resolveCursor(
  args: Record<string, unknown> | null | undefined,
): number | null {
  const value = args?.cursor;
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string") {
    if (!/^\d+$/.test(value.trim())) {
      throw subnetGapsMcpError(
        "invalid_params",
        "cursor must be a non-negative integer.",
      );
    }
    return Number(value.trim());
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw subnetGapsMcpError(
      "invalid_params",
      "cursor must be a non-negative integer.",
    );
  }
  return value;
}

export function subnetGapsQueryUrl(
  args: Record<string, unknown> | null | undefined,
): URL {
  const url = new URL("https://mcp.internal/subnets/gaps");
  requireSubnetGapsNetuid(args);
  const curationLevel = optionalEnum(args, "curation_level", CURATION_LEVELS);
  if (curationLevel) url.searchParams.set("curation_level", curationLevel);
  const missingKinds = resolveMissingKinds(args);
  if (missingKinds) url.searchParams.set("missing_kinds", missingKinds);
  const reviewState = optionalString(args, "review_state");
  if (reviewState) url.searchParams.set("review_state", reviewState);
  const sort = optionalEnum(args, "sort", PRIORITY_SORT_FIELDS);
  if (sort) url.searchParams.set("sort", sort);
  const order = optionalEnum(args, "order", ["asc", "desc"]);
  if (order) url.searchParams.set("order", order);
  if (args?.limit !== undefined) {
    url.searchParams.set("limit", String(clampLimit(args.limit, 50, 100)));
  }
  const cursor = resolveCursor(args);
  if (cursor !== null) url.searchParams.set("cursor", String(cursor));
  return url;
}

export interface SubnetGapsListResult {
  schema_version: unknown;
  contract_version: unknown;
  generated_at: unknown;
  notes: unknown;
  netuid: unknown;
  slug: unknown;
  name: unknown;
  enrichment_queue: unknown;
  priorities: Row[];
  total: unknown;
  returned: unknown;
  limit: unknown;
  cursor: unknown;
  next_cursor: unknown;
  sort: unknown;
  order: unknown;
}

export async function loadSubnetGapsList(
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
): Promise<SubnetGapsListResult> {
  const netuid = requireSubnetGapsNetuid(args);
  const queryUrl = subnetGapsQueryUrl(args);
  const artifactPath = subnetGapsArtifactPath(netuid);
  const read = readArtifact ?? ctx.readArtifact;
  const result = await read(ctx.env, artifactPath);
  if (!result?.ok) {
    const code =
      (result as { code?: string } | undefined)?.code || "artifact_unavailable";
    // Treat cold/unbound storage the same as a missing per-netuid report so
    // GraphQL can keep its schema-stable null degradation (and MCP still gets
    // a not_found toolError).
    if (
      code === "artifact_not_found" ||
      code === "r2_binding_missing" ||
      code === "artifact_unavailable"
    ) {
      throw subnetGapsMcpError(
        "not_found",
        `No gap report exists for netuid ${netuid}.`,
      );
    }
    throw subnetGapsMcpError(code, `Could not load ${artifactPath} (${code}).`);
  }
  const blob = result.data;
  if (!blob || typeof blob !== "object") {
    throw subnetGapsMcpError(
      "not_found",
      `No gap report exists for netuid ${netuid}.`,
    );
  }
  const transformed = applyQueryFilters(
    blob as Record<string, unknown>,
    queryUrl,
    "review-gap-priorities",
    [],
  );
  if (transformed.error) {
    throw subnetGapsMcpError("invalid_params", transformed.error.message);
  }
  const data = transformed.data as Record<string, unknown>;
  const meta = (transformed.meta ?? {}) as Record<string, unknown>;
  const page = (meta.pagination as Record<string, unknown>) || {};
  const rows = Array.isArray(data.priorities) ? (data.priorities as Row[]) : [];
  const rowLen = rows.length;
  return {
    schema_version: data.schema_version ?? null,
    contract_version: data.contract_version ?? null,
    generated_at: data.generated_at ?? null,
    notes: data.notes ?? null,
    netuid: data.netuid ?? netuid,
    slug: data.slug ?? null,
    name: data.name ?? null,
    enrichment_queue: Array.isArray(data.enrichment_queue)
      ? data.enrichment_queue
      : [],
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
