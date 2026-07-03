// Subnet profiles loaders for REST + MCP parity on GET /api/v1/profiles and
// GET /api/v1/subnets/{netuid}/profile. Artifact-backed list-query over
// profiles.json and per-netuid profile detail snapshots.

import { applyQueryFilters } from "../workers/list-query.mjs";
import { API_QUERY_COLLECTIONS, QUERY_ENUMS } from "./contracts.mjs";

const PROFILES_SORT_FIELDS = API_QUERY_COLLECTIONS.profiles.sort_fields;
const NULLABLE_STRING = { type: ["string", "null"] };
const NULLABLE_INT = { type: ["integer", "null"] };

export function profilesMcpError(code, message) {
  const err = new Error(message);
  err.code = code;
  err.profilesMcp = true;
  return err;
}

function optionalString(args, key) {
  const value = args?.[key];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim() === "") {
    throw profilesMcpError(
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
    throw profilesMcpError(
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

export function profilesQueryUrl(args) {
  const url = new URL("https://mcp.internal/profiles");
  if (args?.netuid !== undefined) {
    if (!Number.isInteger(args.netuid) || args.netuid < 0) {
      throw profilesMcpError(
        "invalid_params",
        "netuid must be a non-negative integer.",
      );
    }
    url.searchParams.set("netuid", String(args.netuid));
  }
  const q = optionalString(args, "q");
  if (q) url.searchParams.set("q", q);
  const subnetType = optionalEnum(args, "subnet_type", QUERY_ENUMS.subnetType);
  if (subnetType) url.searchParams.set("subnet_type", subnetType);
  const curationLevel = optionalEnum(
    args,
    "curation_level",
    QUERY_ENUMS.curationLevel,
  );
  if (curationLevel) url.searchParams.set("curation_level", curationLevel);
  const reviewState = optionalString(args, "review_state");
  if (reviewState) url.searchParams.set("review_state", reviewState);
  const confidence = optionalEnum(args, "confidence", [
    "low",
    "medium",
    "high",
  ]);
  if (confidence) url.searchParams.set("confidence", confidence);
  const profileLevel = optionalEnum(
    args,
    "profile_level",
    QUERY_ENUMS.profileLevel,
  );
  if (profileLevel) url.searchParams.set("profile_level", profileLevel);
  const sort = optionalEnum(args, "sort", PROFILES_SORT_FIELDS);
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
      throw profilesMcpError(
        "invalid_params",
        "cursor must be a non-negative integer.",
      );
    }
    url.searchParams.set("cursor", String(args.cursor));
  }
  return url;
}

export async function loadProfilesList(ctx, args, deps) {
  const queryUrl = profilesQueryUrl(args);
  const blob = await deps.readOptionalArtifact(ctx, "/metagraph/profiles.json");
  if (!blob || typeof blob !== "object") {
    throw profilesMcpError("not_found", "Profiles snapshot unavailable.");
  }
  const transformed = applyQueryFilters(blob, queryUrl, "profiles", []);
  if (transformed.error) {
    throw profilesMcpError("invalid_params", transformed.error.message);
  }
  const { data, meta } = transformed;
  const page = meta.pagination || {};
  const profiles = Array.isArray(data.profiles) ? data.profiles : [];
  const profileLen = profiles.length;
  return {
    captured_at: data.captured_at ?? null,
    profiles,
    total: page.total ?? profileLen,
    returned: page.returned ?? profileLen,
    limit: page.limit ?? profileLen,
    cursor: page.cursor ?? 0,
    next_cursor: page.next_cursor ?? null,
    sort: page.sort ?? null,
    order: page.order ?? null,
  };
}

export async function loadSubnetProfile(ctx, netuid, deps) {
  if (!Number.isInteger(netuid) || netuid < 0) {
    throw profilesMcpError(
      "invalid_params",
      "netuid must be a non-negative integer.",
    );
  }
  return deps.readArtifact(ctx, `/metagraph/profiles/${netuid}.json`);
}

export const LIST_PROFILES_INSTRUCTIONS =
  "list_profiles the public-safe subnet profile index (completeness scores, " +
  "curation level, review state), ";

export const LIST_PROFILES_MCP_TOOL = {
  name: "list_profiles",
  title: "List subnet profiles",
  description:
    "Fetch the public-safe subnet profile index: completeness scores, surface " +
    "and interface counts, curation level, review state, and confidence for " +
    "every registered subnet. Filter by netuid, subnet_type, curation_level, " +
    "review_state, confidence, or profile_level; search by name/slug/project " +
    "(q); sort with sort + order; page with limit (1-1000) / cursor. Mirrors " +
    "GET /api/v1/profiles.",
  inputSchema: {
    type: "object",
    properties: {
      netuid: {
        type: "integer",
        description: "Filter to one subnet netuid.",
        minimum: 0,
      },
      subnet_type: {
        type: "string",
        enum: QUERY_ENUMS.subnetType,
        description: "Filter by subnet type.",
      },
      curation_level: {
        type: "string",
        enum: QUERY_ENUMS.curationLevel,
        description: "Filter by curation level.",
      },
      review_state: {
        type: "string",
        description: "Filter by review state.",
      },
      confidence: {
        type: "string",
        enum: ["low", "medium", "high"],
        description: "Filter by profile confidence.",
      },
      profile_level: {
        type: "string",
        enum: QUERY_ENUMS.profileLevel,
        description: "Filter by profile completeness level.",
      },
      q: {
        type: "string",
        description:
          "Search subnet name, slug, project name, team, or categories.",
      },
      sort: {
        type: "string",
        enum: PROFILES_SORT_FIELDS,
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
          "Comma-separated projection of profile row fields to return.",
      },
      limit: {
        type: "integer",
        description: "Max profile rows to return (1-1000). Enables pagination.",
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

export const GET_SUBNET_PROFILE_MCP_TOOL = {
  name: "get_subnet_profile",
  title: "Get one subnet's public profile",
  description:
    "Fetch the public-safe profile detail for one subnet by netuid: completeness " +
    "score, curation and review metadata, native identity signals, surface " +
    "counts, and contributor-facing enrichment context. Mirrors " +
    "GET /api/v1/subnets/{netuid}/profile.",
  inputSchema: {
    type: "object",
    properties: {
      netuid: {
        type: "integer",
        description: "Subnet netuid.",
        minimum: 0,
      },
    },
    required: ["netuid"],
    additionalProperties: false,
  },
};

export const LIST_PROFILES_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: ["profiles"],
  properties: {
    captured_at: NULLABLE_STRING,
    profiles: { type: "array", items: { type: "object" } },
    total: { type: "integer" },
    returned: { type: "integer" },
    limit: { type: "integer" },
    cursor: { type: "integer" },
    next_cursor: NULLABLE_INT,
    sort: NULLABLE_STRING,
    order: NULLABLE_STRING,
  },
};

export const GET_SUBNET_PROFILE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: true,
  properties: {
    schema_version: { type: "integer" },
    contract_version: NULLABLE_STRING,
    generated_at: NULLABLE_STRING,
    subnet: { type: ["object", "null"] },
    profile: { type: ["object", "null"] },
    surfaces: { type: "array", items: { type: "object" } },
    endpoints: { type: "array", items: { type: "object" } },
    gaps: { type: ["object", "null"] },
  },
};
