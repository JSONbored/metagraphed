// Per-subnet interface gap-priority list loader for MCP parity on
// GET /api/v1/subnets/{netuid}/gaps. Applies the same list-query transforms
// as the REST route over the baked /metagraph/review/gaps/{netuid}.json
// artifact.

import { applyQueryFilters, type Row } from "../workers/list-query.ts";
import type { StorageReadResult } from "../workers/storage.ts";
import { API_QUERY_COLLECTIONS, QUERY_ENUMS } from "./contracts.ts";

// The REST route pages this artifact through the review-gap-priorities
// collection (rows live under `priorities`), not the network-wide `gaps`
// collection -- keep both the sort fields and the filter set sourced from it.
const GAP_PRIORITY_SORT_FIELDS =
  API_QUERY_COLLECTIONS["review-gap-priorities"].sort_fields;
const CURATION_LEVELS = QUERY_ENUMS.curationLevel;
const SURFACE_KINDS = QUERY_ENUMS.surfaceKind;
// netuid is the path param (excluded from the REST list query).
const SUBNET_GAPS_QUERY_FILTER_NAMES = [
  "curation_level",
  "missing_kinds",
  "review_state",
];

export function subnetGapsArtifactPath(netuid: unknown): string {
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

function requireNetuid(
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

export function subnetGapsQueryUrl(
  args: Record<string, unknown> | null | undefined,
): URL {
  const url = new URL("https://mcp.internal/subnets/gaps");
  requireNetuid(args);
  const curationLevel = optionalEnum(args, "curation_level", CURATION_LEVELS);
  if (curationLevel) url.searchParams.set("curation_level", curationLevel);
  const missingKinds = optionalEnum(args, "missing_kinds", SURFACE_KINDS);
  if (missingKinds) url.searchParams.set("missing_kinds", missingKinds);
  const reviewState = optionalString(args, "review_state");
  if (reviewState) url.searchParams.set("review_state", reviewState);
  const sort = optionalEnum(args, "sort", GAP_PRIORITY_SORT_FIELDS);
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
      throw subnetGapsMcpError(
        "invalid_params",
        "cursor must be a non-negative integer.",
      );
    }
    url.searchParams.set("cursor", String(cursor));
  }
  return url;
}

export interface SubnetGapsListResult {
  generated_at: unknown;
  netuid: unknown;
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
  const netuid = requireNetuid(args);
  const queryUrl = subnetGapsQueryUrl(args);
  const artifactPath = subnetGapsArtifactPath(netuid);
  const read = readArtifact ?? ctx.readArtifact;
  const result = await read(ctx.env, artifactPath);
  if (!result?.ok) {
    const code =
      (result as { code?: string } | undefined)?.code || "artifact_unavailable";
    if (code === "artifact_not_found") {
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
    // Collection KEY (indexes API_QUERY_COLLECTIONS), not the row key -- the
    // rows themselves live under this collection's data_key, `priorities`.
    "review-gap-priorities",
    SUBNET_GAPS_QUERY_FILTER_NAMES,
  );
  if (transformed.error) {
    throw subnetGapsMcpError("invalid_params", transformed.error.message);
  }
  const data = transformed.data as Record<string, unknown>;
  const meta = transformed.meta as Record<string, unknown>;
  const page = (meta.pagination as Record<string, unknown>) || {};
  const rows = Array.isArray(data.priorities) ? (data.priorities as Row[]) : [];
  const rowLen = rows.length;
  return {
    generated_at: data.generated_at ?? null,
    netuid: data.netuid ?? netuid,
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

export const LIST_SUBNET_GAPS_INSTRUCTIONS =
  "list_subnet_gaps one subnet's interface gap priorities with REST list-query " +
  "filters (curation_level, missing_kinds, review_state, and pagination; " +
  "mirrors GET /api/v1/subnets/{netuid}/gaps), ";

export const LIST_SUBNET_GAPS_MCP_TOOL = {
  name: "list_subnet_gaps",
  title: "List one subnet's interface gap priorities",
  description:
    "Fetch interface gap priorities for one subnet by netuid: the surface " +
    "kinds still missing, the subnet's curation level, and the review state " +
    "driving contributor targeting. Filter by curation_level, missing_kinds, " +
    "or review_state; sort with sort + order; and page with limit (1-100) / " +
    "cursor. Distinct from get_subnet_gaps (raw artifact dump, which also " +
    "carries the enrichment queue). Mirrors GET /api/v1/subnets/{netuid}/gaps.",
  inputSchema: {
    type: "object",
    properties: {
      netuid: {
        type: "integer",
        description: "Subnet netuid.",
        minimum: 0,
      },
      curation_level: {
        type: "string",
        enum: CURATION_LEVELS,
        description: "Filter by the subnet's curation level.",
      },
      missing_kinds: {
        type: "string",
        enum: SURFACE_KINDS,
        description: "Filter to rows missing this surface kind.",
      },
      review_state: {
        type: "string",
        description: "Filter by review state.",
      },
      sort: {
        type: "string",
        enum: GAP_PRIORITY_SORT_FIELDS,
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
          "Comma-separated projection of gap-priority row fields to return.",
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

export const LIST_SUBNET_GAPS_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: ["priorities"],
  properties: {
    generated_at: NULLABLE_STRING,
    netuid: NULLABLE_INT,
    priorities: { type: "array", items: { type: "object" } },
    total: { type: "integer" },
    returned: { type: "integer" },
    limit: { type: "integer" },
    cursor: { type: "integer" },
    next_cursor: NULLABLE_INT,
    sort: NULLABLE_STRING,
    order: NULLABLE_STRING,
  },
};
