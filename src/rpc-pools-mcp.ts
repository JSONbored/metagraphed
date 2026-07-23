// RPC pool list loader for MCP parity on GET /api/v1/rpc/pools (#6570).
// Applies the same list-query transforms as the REST route over the baked
// /metagraph/rpc/pools.json artifact, after the live 15-minute cron overlay
// (overlayRpcPoolEligibility) — same order REST's liveHealthOverlay ->
// applyQueryFilters pipeline uses, so a filter like min_eligible_count reads
// live eligibility, not a stale baked value. Structurally mirrors
// endpoint-pools-mcp.ts (the generalized sibling collection), which has no
// live-overlay step of its own.

import { applyQueryFilters, type Row } from "../workers/list-query.ts";
import type { StorageReadResult } from "../workers/storage.ts";
import { API_QUERY_COLLECTIONS } from "./contracts.ts";
import { KV_HEALTH_RPC_POOL } from "./health-prober.ts";
import { overlayRpcPoolEligibility } from "./health-serving.ts";

export const RPC_POOLS_ARTIFACT = "/metagraph/rpc/pools.json";

const POOL_SORT_FIELDS = API_QUERY_COLLECTIONS["rpc-pools"].sort_fields;
const POOL_KINDS = ["subtensor-rpc", "subtensor-wss", "archive"];

export interface RpcPoolsMcpError extends Error {
  toolError: true;
  code: string;
}

export function rpcPoolsMcpError(
  code: string,
  message: string,
): RpcPoolsMcpError {
  const error = new Error(message) as RpcPoolsMcpError;
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
    throw rpcPoolsMcpError(
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
    throw rpcPoolsMcpError(
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
    throw rpcPoolsMcpError(
      "invalid_params",
      `Argument \`${key}\` must be a finite number when provided.`,
    );
  }
  return value;
}

export function rpcPoolsQueryUrl(
  args: Record<string, unknown> | null | undefined,
): URL {
  const url = new URL("https://mcp.internal/rpc-pools");
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
      throw rpcPoolsMcpError(
        "invalid_params",
        "limit must be an integer between 1 and 100.",
      );
    }
    url.searchParams.set("limit", String(limit));
  }
  if (args?.cursor !== undefined) {
    const cursor = args.cursor;
    if (typeof cursor !== "number" || !Number.isInteger(cursor) || cursor < 0) {
      throw rpcPoolsMcpError(
        "invalid_params",
        "cursor must be a non-negative integer.",
      );
    }
    url.searchParams.set("cursor", String(cursor));
  }
  return url;
}

interface RpcPoolsMcpCtx {
  env: Env;
  readArtifact: (env: Env, path: string) => Promise<StorageReadResult>;
  readHealthKv?: (
    env: Env,
    key: string,
  ) => Promise<Record<string, unknown> | null>;
}

export interface RpcPoolsListResult {
  generated_at: unknown;
  notes: unknown;
  source: unknown;
  operational_observed_at: unknown;
  pools: Row[];
  total: unknown;
  returned: unknown;
  limit: unknown;
  cursor: unknown;
  next_cursor: unknown;
  sort: unknown;
  order: unknown;
}

export async function loadRpcPoolsList(
  ctx: RpcPoolsMcpCtx,
  args: Record<string, unknown> | null | undefined,
  {
    readArtifact,
  }: {
    readArtifact?: (env: Env, path: string) => Promise<StorageReadResult>;
  } = {},
): Promise<RpcPoolsListResult> {
  const queryUrl = rpcPoolsQueryUrl(args);
  const read = readArtifact ?? ctx.readArtifact;
  const result = await read(ctx.env, RPC_POOLS_ARTIFACT);
  if (!result?.ok) {
    const code =
      (result as { code?: string } | undefined)?.code || "artifact_unavailable";
    if (code === "artifact_not_found") {
      throw rpcPoolsMcpError("not_found", "RPC pool snapshot unavailable.");
    }
    throw rpcPoolsMcpError(
      code,
      `Could not load ${RPC_POOLS_ARTIFACT} (${code}).`,
    );
  }
  const blob = result.data;
  if (!blob || typeof blob !== "object") {
    throw rpcPoolsMcpError("not_found", "RPC pool snapshot unavailable.");
  }

  // Live 15-minute cron overlay, matching REST's liveHealthOverlay for the
  // "rpc-pools" route id — applied before filtering so a live-derived field
  // like eligible_count reflects the current snapshot, not the baked one.
  let overlaid = blob as Record<string, unknown>;
  const livePool = ctx.readHealthKv
    ? await ctx.readHealthKv(ctx.env, KV_HEALTH_RPC_POOL)
    : null;
  if (
    livePool &&
    Array.isArray(livePool.endpoints) &&
    Array.isArray(overlaid.pools)
  ) {
    overlaid = {
      ...overlaid,
      source: "live-cron-prober",
      operational_observed_at: livePool.last_run_at || null,
      pools: (overlaid.pools as Row[]).map((pool) =>
        overlayRpcPoolEligibility(pool, livePool),
      ),
    };
  }

  const transformed = applyQueryFilters(overlaid, queryUrl, "rpc-pools", []);
  if (transformed.error) {
    throw rpcPoolsMcpError("invalid_params", transformed.error.message);
  }
  const data = transformed.data as Record<string, unknown>;
  const meta = transformed.meta as Record<string, unknown>;
  const page = (meta.pagination as Record<string, unknown>) || {};
  const rows = Array.isArray(data.pools) ? (data.pools as Row[]) : [];
  const rowLen = rows.length;
  return {
    generated_at: data.generated_at ?? null,
    notes: data.notes ?? null,
    source: data.source ?? null,
    operational_observed_at: data.operational_observed_at ?? null,
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

export const LIST_RPC_POOLS_MCP_TOOL = {
  name: "list_rpc_pools",
  title: "List Bittensor RPC pools",
  description:
    "Fetch the load-balanced Bittensor RPC pool scores: each pool's kind, " +
    "eligible endpoint count, total endpoint count, and probe-derived routing " +
    "score, as used to route the public RPC proxy. Filter by id or kind, " +
    "threshold with min_/max_eligible_count and min_/max_endpoint_count, sort " +
    "with sort + order, and page with limit (1-100) / cursor. Complements " +
    "list_rpc_endpoints (the individual endpoints), get_best_rpc_endpoint (the " +
    "pick-one shortcut), and list_endpoint_pools (the generalized sibling). " +
    "Mirrors GET /api/v1/rpc/pools.",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "Filter to one pool id, e.g. 'finney-rpc'.",
      },
      kind: {
        type: "string",
        enum: POOL_KINDS,
        description: "Filter by pool kind.",
      },
      min_eligible_count: {
        type: "number",
        description: "Keep pools with eligible_count >= this bound.",
      },
      max_eligible_count: {
        type: "number",
        description: "Keep pools with eligible_count <= this bound.",
      },
      min_endpoint_count: {
        type: "number",
        description: "Keep pools with endpoint_count >= this bound.",
      },
      max_endpoint_count: {
        type: "number",
        description: "Keep pools with endpoint_count <= this bound.",
      },
      sort: {
        type: "string",
        enum: POOL_SORT_FIELDS,
        description: "Field to sort by before paging.",
      },
      order: {
        type: "string",
        enum: ["asc", "desc"],
        description: "Sort direction for sort (default asc).",
      },
      fields: {
        type: "string",
        description: "Comma-separated projection of pool row fields to return.",
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

export const LIST_RPC_POOLS_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: ["pools"],
  properties: {
    generated_at: NULLABLE_STRING,
    notes: {
      type: ["array", "string", "null"],
      items: { type: "string" },
    },
    source: NULLABLE_STRING,
    operational_observed_at: NULLABLE_STRING,
    pools: { type: "array", items: { type: "object" } },
    total: { type: "integer" },
    returned: { type: "integer" },
    limit: { type: "integer" },
    cursor: { type: "integer" },
    next_cursor: NULLABLE_INT,
    sort: NULLABLE_STRING,
    order: NULLABLE_STRING,
  },
};
