// Network-wide economics collection loader for REST + MCP parity.
// Pure orchestration over resolveLiveEconomics + applyQueryFilters; MCP/REST
// handlers keep tier precedence and envelope wiring.

import { applyQueryFilters } from "../workers/list-query.ts";
import { API_QUERY_COLLECTIONS } from "./contracts.mjs";
import { resolveLiveEconomics } from "./health-serving.mjs";

const ECONOMICS_SORT_FIELDS = API_QUERY_COLLECTIONS.economics.sort_fields;
const NULLABLE_STRING = { type: ["string", "null"] };
const NULLABLE_INT = { type: ["integer", "null"] };

export function networkEconomicsError(code, message) {
  const err = new Error(message);
  err.code = code;
  err.networkEconomics = true;
  return err;
}

function optionalString(args, key) {
  const value = args?.[key];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim() === "") {
    throw networkEconomicsError(
      "invalid_params",
      `Argument \`${key}\` must be a non-empty string when provided.`,
    );
  }
  return value.trim();
}

function optionalEnum(args, key, allowed) {
  const value = args?.[key];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw networkEconomicsError(
      "invalid_params",
      `Argument \`${key}\` must be one of: ${allowed.join(", ")}.`,
    );
  }
  return value;
}

function clampLimit(value, fallback, max) {
  if (typeof value !== "number") return fallback;
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.min(max, Math.floor(value));
}

export function economicsQueryUrl(args) {
  const url = new URL("https://mcp.internal/economics");
  if (args?.netuid !== undefined) {
    if (!Number.isInteger(args.netuid) || args.netuid < 0) {
      throw networkEconomicsError(
        "invalid_params",
        "netuid must be a non-negative integer.",
      );
    }
    url.searchParams.set("netuid", String(args.netuid));
  }
  const q = optionalString(args, "q");
  if (q) url.searchParams.set("q", q);
  const registrationAllowed = optionalEnum(args, "registration_allowed", [
    "true",
    "false",
  ]);
  if (registrationAllowed) {
    url.searchParams.set("registration_allowed", registrationAllowed);
  }
  const sort = optionalEnum(args, "sort", ECONOMICS_SORT_FIELDS);
  if (sort) url.searchParams.set("sort", sort);
  const order = optionalEnum(args, "order", ["asc", "desc"]);
  if (order) url.searchParams.set("order", order);
  const fields = optionalString(args, "fields");
  if (fields) url.searchParams.set("fields", fields);
  if (args?.limit !== undefined) {
    url.searchParams.set("limit", String(clampLimit(args.limit, 100, 1000)));
  }
  if (args?.cursor !== undefined) {
    if (!Number.isInteger(args.cursor) || args.cursor < 0) {
      throw networkEconomicsError(
        "invalid_params",
        "cursor must be a non-negative integer.",
      );
    }
    url.searchParams.set("cursor", String(args.cursor));
  }
  return url;
}

export async function loadNetworkEconomics(ctx, args, deps) {
  // Validate/build the list-query URL before any tier I/O so invalid_params
  // (netuid, cursor, sort, …) never triggers live-KV or R2 reads.
  const queryUrl = economicsQueryUrl(args);
  const live = await resolveLiveEconomics({
    readHealthKv: ctx.readHealthKv,
    env: ctx.env,
    contractVersion: deps.contractVersion(ctx),
  });
  let blob = live?.data;
  let source = live?.source ?? null;
  if (!blob) {
    blob = await deps.readOptionalArtifact(ctx, "/metagraph/economics.json");
    source = "r2-fallback";
  }
  if (!blob || typeof blob !== "object") {
    throw networkEconomicsError("not_found", "Economics snapshot unavailable.");
  }
  const transformed = applyQueryFilters(blob, queryUrl, "economics", []);
  if (transformed.error) {
    throw networkEconomicsError("invalid_params", transformed.error.message);
  }
  const { data, meta } = transformed;
  const page = meta.pagination || {};
  const subnets = Array.isArray(data.subnets) ? data.subnets : [];
  const subnetLen = subnets.length;
  return {
    source: source || "r2-fallback",
    captured_at: data.captured_at ?? null,
    network: data.network ?? null,
    summary: data.summary ?? null,
    subnets,
    total: page.total ?? subnetLen,
    returned: page.returned ?? subnetLen,
    limit: page.limit ?? subnetLen,
    cursor: page.cursor ?? 0,
    next_cursor: page.next_cursor ?? null,
    sort: page.sort ?? null,
    order: page.order ?? null,
  };
}

export const GET_ECONOMICS_INSTRUCTIONS =
  "get_economics the live network-wide economics " +
  "scorecard (filterable/sortable per-subnet rows), ";

export const GET_ECONOMICS_MCP_TOOL = {
  name: "get_economics",
  title: "Get network-wide subnet economics",
  description:
    "Fetch the live network-wide economics scorecard: per-subnet validator " +
    "and miner counts, registration cost and whether registration is open, open " +
    "slots, stake, alpha price, emission share, and summary totals. Served " +
    "live from the economics tier (~3h), falling back to the latest committed " +
    "snapshot. Filter by netuid or registration_allowed, search by name/slug " +
    "(q), sort with sort + order, and page with limit (1-1000) / cursor. " +
    "Mirrors GET /api/v1/economics.",
  inputSchema: {
    type: "object",
    properties: {
      netuid: {
        type: "integer",
        description: "Filter to one subnet netuid.",
        minimum: 0,
      },
      registration_allowed: {
        type: "string",
        enum: ["true", "false"],
        description:
          "Filter to subnets where registration is open (true) or closed (false).",
      },
      q: {
        type: "string",
        description: "Search subnet name or slug (case-insensitive).",
      },
      sort: {
        type: "string",
        enum: ECONOMICS_SORT_FIELDS,
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
          "Comma-separated projection of subnet row fields to return.",
      },
      limit: {
        type: "integer",
        description: "Max subnet rows to return (1-1000). Enables pagination.",
        minimum: 1,
        maximum: 1000,
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

export const GET_ECONOMICS_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: ["source", "subnets"],
  properties: {
    source: NULLABLE_STRING,
    captured_at: NULLABLE_STRING,
    network: NULLABLE_STRING,
    summary: { type: ["object", "null"] },
    subnets: { type: "array", items: { type: "object" } },
    total: { type: "integer" },
    returned: { type: "integer" },
    limit: { type: "integer" },
    cursor: { type: "integer" },
    next_cursor: NULLABLE_INT,
    sort: NULLABLE_STRING,
    order: NULLABLE_STRING,
  },
};
