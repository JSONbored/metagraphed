// Endpoint pool list loader for MCP parity on GET /api/v1/endpoint-pools.
// Applies the same list-query transforms as the REST route over the baked
// /metagraph/endpoint-pools.json artifact.

import { z } from "zod";
import { applyMcpQueryFilters, type Row } from "./mcp-list-query.ts";
import type { StorageReadResult } from "../workers/storage.ts";
import { API_QUERY_COLLECTIONS } from "./contracts.ts";
import {
  ListEndpointPoolsInputSchema,
  ListEndpointPoolsOutputSchema,
} from "../schemas-src/mcp-tools/endpoint-pools-and-provider.ts";

export const ENDPOINT_POOLS_ARTIFACT = "/metagraph/endpoint-pools.json";

const POOL_SORT_FIELDS = API_QUERY_COLLECTIONS["endpoint-pools"].sort_fields;
const POOL_KINDS = ["subtensor-rpc", "subtensor-wss", "archive"];

export interface EndpointPoolsMcpError extends Error {
  toolError: true;
  code: string;
}

export function endpointPoolsMcpError(
  code: string,
  message: string,
): EndpointPoolsMcpError {
  const error = new Error(message) as EndpointPoolsMcpError;
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
    throw endpointPoolsMcpError(
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
    throw endpointPoolsMcpError(
      "invalid_params",
      `Argument \`${key}\` must be one of: ${allowed.join(", ")}.`,
    );
  }
  return value;
}

function optionalRangeBound(
  args: Record<string, unknown> | null | undefined,
  key: string,
): number | null {
  const value = args?.[key];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw endpointPoolsMcpError(
      "invalid_params",
      `Argument \`${key}\` must be a finite number when provided.`,
    );
  }
  return value;
}

export function endpointPoolsQueryUrl(
  args: Record<string, unknown> | null | undefined,
): URL {
  const url = new URL("https://mcp.internal/endpoint-pools");
  const id = optionalString(args, "id");
  if (id) url.searchParams.set("id", id);
  const kind = optionalEnum(args, "kind", POOL_KINDS);
  if (kind) url.searchParams.set("kind", kind);
  const sort = optionalEnum(args, "sort", POOL_SORT_FIELDS);
  if (sort) url.searchParams.set("sort", sort);
  const order = optionalEnum(args, "order", ["asc", "desc"]);
  if (order) url.searchParams.set("order", order);
  const fields = optionalString(args, "fields");
  if (fields) url.searchParams.set("fields", fields);
  const minEligible = optionalRangeBound(args, "min_eligible_count");
  if (minEligible !== null) {
    url.searchParams.set("min_eligible_count", String(minEligible));
  }
  const maxEligible = optionalRangeBound(args, "max_eligible_count");
  if (maxEligible !== null) {
    url.searchParams.set("max_eligible_count", String(maxEligible));
  }
  const minEndpoint = optionalRangeBound(args, "min_endpoint_count");
  if (minEndpoint !== null) {
    url.searchParams.set("min_endpoint_count", String(minEndpoint));
  }
  const maxEndpoint = optionalRangeBound(args, "max_endpoint_count");
  if (maxEndpoint !== null) {
    url.searchParams.set("max_endpoint_count", String(maxEndpoint));
  }
  if (args?.limit !== undefined) {
    const limit = args.limit;
    if (
      typeof limit !== "number" ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      throw endpointPoolsMcpError(
        "invalid_params",
        "limit must be an integer between 1 and 100.",
      );
    }
    url.searchParams.set("limit", String(limit));
  }
  if (args?.cursor !== undefined) {
    const cursor = args.cursor;
    if (typeof cursor !== "number" || !Number.isInteger(cursor) || cursor < 0) {
      throw endpointPoolsMcpError(
        "invalid_params",
        "cursor must be a non-negative integer.",
      );
    }
    url.searchParams.set("cursor", String(cursor));
  }
  return url;
}

export interface EndpointPoolsListResult {
  generated_at: unknown;
  notes: unknown;
  pools: Row[];
  total: unknown;
  returned: unknown;
  limit: unknown;
  cursor: unknown;
  next_cursor: unknown;
  sort: unknown;
  order: unknown;
}

export async function loadEndpointPoolsList(
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
): Promise<EndpointPoolsListResult> {
  const queryUrl = endpointPoolsQueryUrl(args);
  const read = readArtifact ?? ctx.readArtifact;
  const result = await read(ctx.env, ENDPOINT_POOLS_ARTIFACT);
  if (!result?.ok) {
    const code =
      (result as { code?: string } | undefined)?.code || "artifact_unavailable";
    if (code === "artifact_not_found") {
      throw endpointPoolsMcpError(
        "not_found",
        "Endpoint pool snapshot unavailable.",
      );
    }
    throw endpointPoolsMcpError(
      code,
      `Could not load ${ENDPOINT_POOLS_ARTIFACT} (${code}).`,
    );
  }
  const blob = result.data;
  if (!blob || typeof blob !== "object") {
    throw endpointPoolsMcpError(
      "not_found",
      "Endpoint pool snapshot unavailable.",
    );
  }
  const transformed = applyMcpQueryFilters(
    blob as Record<string, unknown>,
    queryUrl,
    "endpoint-pools",
    [],
  );
  if (transformed.error) {
    throw endpointPoolsMcpError("invalid_params", transformed.error.message);
  }
  const data = transformed.data as Record<string, unknown>;
  const meta = transformed.meta as Record<string, unknown>;
  const page = (meta.pagination as Record<string, unknown>) || {};
  const rows = Array.isArray(data.pools) ? (data.pools as Row[]) : [];
  const rowLen = rows.length;
  return {
    generated_at: data.generated_at ?? null,
    notes: data.notes ?? null,
    pools: rows,
    total: page.total ?? rowLen,
    returned: page.returned ?? rowLen,
    limit: page.limit ?? rowLen,
    cursor: page.cursor ?? 0,
    next_cursor: page.next_cursor ?? null,
    sort: page.sort ?? null,
    order: page.order ?? null,
  };
}

export const LIST_ENDPOINT_POOLS_INSTRUCTIONS =
  "list_endpoint_pools generalized endpoint pool scores (eligible/endpoint counts; " +
  "mirrors GET /api/v1/endpoint-pools), ";

export const LIST_ENDPOINT_POOLS_MCP_TOOL = {
  name: "list_endpoint_pools",
  title: "List generalized endpoint pools",
  description:
    "Fetch generalized endpoint pool scores from the registry: each pool's kind, " +
    "eligible endpoint count, total endpoint count, and probe-derived routing score. " +
    "Filter by id or kind, threshold with min_/max_eligible_count and " +
    "min_/max_endpoint_count, sort with sort + order, and page with limit (1-100) / " +
    "cursor. Complements list_endpoints (individual resources) and list_rpc_pools " +
    "(Bittensor RPC proxy pools). Mirrors GET /api/v1/endpoint-pools.",
  inputSchema: z.toJSONSchema(ListEndpointPoolsInputSchema, {
    target: "draft-2020-12",
  }),
};

export const LIST_ENDPOINT_POOLS_OUTPUT_SCHEMA = z.toJSONSchema(
  ListEndpointPoolsOutputSchema,
  {
    target: "draft-2020-12",
  },
);
