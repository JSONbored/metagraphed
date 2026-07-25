// Per-subnet curated-surface list loader for MCP parity on
// GET /api/v1/subnets/{netuid}/surfaces. Applies the same list-query
// transforms as the REST route over the baked
// /metagraph/surfaces/{netuid}.json artifact.

import { z } from "zod";
import { applyQueryFilters, type Row } from "../workers/list-query.ts";
import type { StorageReadResult } from "../workers/storage.ts";
import { API_QUERY_COLLECTIONS, QUERY_ENUMS } from "./contracts.ts";
import {
  ListSubnetSurfacesInputSchema,
  ListSubnetSurfacesOutputSchema,
} from "../schemas-src/mcp-tools/subnet-scoped-lists.ts";

const SURFACE_SORT_FIELDS =
  API_QUERY_COLLECTIONS["curated-surfaces"].sort_fields;
const SURFACE_KINDS = QUERY_ENUMS.surfaceKind;
const SUBNET_SURFACES_QUERY_FILTER_NAMES = ["kind", "provider", "id"];

export function subnetSurfacesArtifactPath(netuid: unknown): string {
  return `/metagraph/surfaces/${netuid}.json`;
}

export interface SubnetSurfacesMcpError extends Error {
  toolError: true;
  code: string;
}

export function subnetSurfacesMcpError(
  code: string,
  message: string,
): SubnetSurfacesMcpError {
  const error = new Error(message) as SubnetSurfacesMcpError;
  error.toolError = true;
  error.code = code;
  return error;
}

function requireNetuid(
  args: Record<string, unknown> | null | undefined,
): number {
  const netuid = args?.netuid;
  if (typeof netuid !== "number" || !Number.isInteger(netuid) || netuid < 0) {
    throw subnetSurfacesMcpError(
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
    throw subnetSurfacesMcpError(
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
    throw subnetSurfacesMcpError(
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

export function subnetSurfacesQueryUrl(
  args: Record<string, unknown> | null | undefined,
): URL {
  const url = new URL("https://mcp.internal/subnets/surfaces");
  requireNetuid(args);
  const kind = optionalEnum(args, "kind", SURFACE_KINDS);
  if (kind) url.searchParams.set("kind", kind);
  const provider = optionalString(args, "provider");
  if (provider) url.searchParams.set("provider", provider);
  const id = optionalString(args, "id");
  if (id) url.searchParams.set("id", id);
  const sort = optionalEnum(args, "sort", SURFACE_SORT_FIELDS);
  if (sort) url.searchParams.set("sort", sort);
  const order = optionalEnum(args, "order", ["asc", "desc"]);
  if (order) url.searchParams.set("order", order);
  if (args?.limit !== undefined) {
    url.searchParams.set("limit", String(clampLimit(args.limit, 50, 100)));
  }
  if (args?.cursor !== undefined) {
    const cursor = args.cursor;
    if (typeof cursor !== "number" || !Number.isInteger(cursor) || cursor < 0) {
      throw subnetSurfacesMcpError(
        "invalid_params",
        "cursor must be a non-negative integer.",
      );
    }
    url.searchParams.set("cursor", String(cursor));
  }
  return url;
}

export interface SubnetSurfacesListResult {
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

export async function loadSubnetSurfacesList(
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
): Promise<SubnetSurfacesListResult> {
  const netuid = requireNetuid(args);
  const queryUrl = subnetSurfacesQueryUrl(args);
  const artifactPath = subnetSurfacesArtifactPath(netuid);
  const read = readArtifact ?? ctx.readArtifact;
  const result = await read(ctx.env, artifactPath);
  if (!result?.ok) {
    const code =
      (result as { code?: string } | undefined)?.code || "artifact_unavailable";
    if (code === "artifact_not_found") {
      throw subnetSurfacesMcpError(
        "not_found",
        `No surface snapshot exists for netuid ${netuid}.`,
      );
    }
    throw subnetSurfacesMcpError(
      code,
      `Could not load ${artifactPath} (${code}).`,
    );
  }
  const blob = result.data;
  if (!blob || typeof blob !== "object") {
    throw subnetSurfacesMcpError(
      "not_found",
      `No surface snapshot exists for netuid ${netuid}.`,
    );
  }
  const transformed = applyQueryFilters(
    blob as Record<string, unknown>,
    queryUrl,
    "curated-surfaces",
    SUBNET_SURFACES_QUERY_FILTER_NAMES,
  );
  if (transformed.error) {
    throw subnetSurfacesMcpError("invalid_params", transformed.error.message);
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

export const LIST_SUBNET_SURFACES_INSTRUCTIONS =
  "list_subnet_surfaces one subnet's curated public surfaces with REST " +
  "list-query filters (kind, provider, id, sort/order, and pagination; mirrors " +
  "GET /api/v1/subnets/{netuid}/surfaces), ";

export const LIST_SUBNET_SURFACES_MCP_TOOL = {
  name: "list_subnet_surfaces",
  title: "List one subnet's curated surfaces",
  description:
    "Fetch curated public interface surfaces for one subnet by netuid: each " +
    "promoted surface with its kind, provider, title, url, and review state. " +
    "Filter by kind, provider, or id; sort with sort + order; and page with " +
    "limit (1-100) / cursor. The filtered sibling of get_subnet_surfaces (raw " +
    "artifact dump). Mirrors GET /api/v1/subnets/{netuid}/surfaces.",
  inputSchema: z.toJSONSchema(ListSubnetSurfacesInputSchema, {
    target: "draft-2020-12",
  }),
};

export const LIST_SUBNET_SURFACES_OUTPUT_SCHEMA = z.toJSONSchema(
  ListSubnetSurfacesOutputSchema,
  {
    target: "draft-2020-12",
  },
);
