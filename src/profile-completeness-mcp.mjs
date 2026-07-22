// Profile completeness list loader for MCP parity on
// GET /api/v1/review/profile-completeness. Applies the same list-query
// transforms as the REST route over the baked
// /metagraph/review/profile-completeness.json artifact.

import { applyQueryFilters } from "../workers/list-query.ts";
import { API_QUERY_COLLECTIONS, QUERY_ENUMS } from "./contracts.mjs";

export const PROFILE_COMPLETENESS_ARTIFACT =
  "/metagraph/review/profile-completeness.json";

const PROFILE_SORT_FIELDS =
  API_QUERY_COLLECTIONS["profile-completeness"].sort_fields;
const PROFILE_LEVELS = QUERY_ENUMS.profileLevel;
const SURFACE_KINDS = QUERY_ENUMS.surfaceKind;
const CONFIDENCE_LEVELS = ["low", "medium", "high"];
const IDENTITY_LEVELS = ["none", "directory", "partial", "complete"];
const NATIVE_NAME_QUALITIES = ["chain", "placeholder", "empty"];

export function profileCompletenessMcpError(code, message) {
  const error = new Error(message);
  error.toolError = true;
  error.code = code;
  return error;
}

function optionalString(args, key) {
  const value = args?.[key];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim() === "") {
    throw profileCompletenessMcpError(
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
    throw profileCompletenessMcpError(
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

export function profileCompletenessQueryUrl(args) {
  const url = new URL("https://mcp.internal/review/profile-completeness");
  if (args?.netuid !== undefined) {
    if (!Number.isInteger(args.netuid) || args.netuid < 0) {
      throw profileCompletenessMcpError(
        "invalid_params",
        "netuid must be a non-negative integer.",
      );
    }
    url.searchParams.set("netuid", String(args.netuid));
  }
  const profileLevel = optionalEnum(args, "profile_level", PROFILE_LEVELS);
  if (profileLevel) url.searchParams.set("profile_level", profileLevel);
  const confidence = optionalEnum(args, "confidence", CONFIDENCE_LEVELS);
  if (confidence) url.searchParams.set("confidence", confidence);
  const identityLevel = optionalEnum(args, "identity_level", IDENTITY_LEVELS);
  if (identityLevel) url.searchParams.set("identity_level", identityLevel);
  const identityPromotionKinds = optionalEnum(
    args,
    "identity_promotion_kinds",
    SURFACE_KINDS,
  );
  if (identityPromotionKinds) {
    url.searchParams.set("identity_promotion_kinds", identityPromotionKinds);
  }
  const nativeNameQuality = optionalEnum(
    args,
    "native_name_quality",
    NATIVE_NAME_QUALITIES,
  );
  if (nativeNameQuality) {
    url.searchParams.set("native_name_quality", nativeNameQuality);
  }
  const sort = optionalEnum(args, "sort", PROFILE_SORT_FIELDS);
  if (sort) url.searchParams.set("sort", sort);
  const order = optionalEnum(args, "order", ["asc", "desc"]);
  if (order) url.searchParams.set("order", order);
  const fields = optionalString(args, "fields");
  if (fields) url.searchParams.set("fields", fields);
  if (args?.limit !== undefined) {
    url.searchParams.set("limit", String(clampLimit(args.limit, 50, 100)));
  }
  if (args?.cursor !== undefined) {
    if (!Number.isInteger(args.cursor) || args.cursor < 0) {
      throw profileCompletenessMcpError(
        "invalid_params",
        "cursor must be a non-negative integer.",
      );
    }
    url.searchParams.set("cursor", String(args.cursor));
  }
  return url;
}

export async function loadProfileCompletenessList(
  ctx,
  args,
  { readArtifact } = {},
) {
  const queryUrl = profileCompletenessQueryUrl(args);
  const read = readArtifact ?? ctx.readArtifact;
  const result = await read(ctx.env, PROFILE_COMPLETENESS_ARTIFACT);
  if (!result?.ok) {
    const code = result?.code || "artifact_unavailable";
    if (code === "artifact_not_found") {
      throw profileCompletenessMcpError(
        "not_found",
        "Profile completeness snapshot unavailable.",
      );
    }
    throw profileCompletenessMcpError(
      code,
      `Could not load ${PROFILE_COMPLETENESS_ARTIFACT} (${code}).`,
    );
  }
  const blob = result.data;
  if (!blob || typeof blob !== "object") {
    throw profileCompletenessMcpError(
      "not_found",
      "Profile completeness snapshot unavailable.",
    );
  }
  const transformed = applyQueryFilters(
    blob,
    queryUrl,
    "profile-completeness",
    [],
  );
  if (transformed.error) {
    throw profileCompletenessMcpError(
      "invalid_params",
      transformed.error.message,
    );
  }
  const { data, meta } = transformed;
  const page = meta.pagination || {};
  const rows = Array.isArray(data.profiles) ? data.profiles : [];
  const rowLen = rows.length;
  return {
    generated_at: data.generated_at ?? null,
    notes: data.notes ?? null,
    summary: data.summary ?? null,
    profiles: rows,
    total: page.total ?? rowLen,
    returned: page.returned ?? rowLen,
    limit: page.limit ?? rowLen,
    cursor: page.cursor ?? 0,
    next_cursor: page.next_cursor ?? null,
    sort: page.sort ?? null,
    order: page.order ?? null,
  };
}

export const LIST_PROFILE_COMPLETENESS_INSTRUCTIONS =
  "list_profile_completeness the contributor review queue of subnet " +
  "profile-completeness gaps (identity, native name, confidence; mirrors " +
  "GET /api/v1/review/profile-completeness), ";

export const LIST_PROFILE_COMPLETENESS_MCP_TOOL = {
  name: "list_profile_completeness",
  title: "List subnet profile-completeness gaps",
  description:
    "Fetch the contributor review queue of subnet profile-completeness gaps: " +
    "which subnets have incomplete public-safe profiles (missing identity, " +
    "native name, confidence, or promotion signals) and are worth profile " +
    "enrichment. Filter by netuid, profile_level, confidence, identity_level, " +
    "identity_promotion_kinds, or native_name_quality; sort with sort + order; " +
    "and page with limit (1-100) / cursor. Use it to find high-value profile " +
    "contributions. Mirrors GET /api/v1/review/profile-completeness.",
  inputSchema: {
    type: "object",
    properties: {
      netuid: {
        type: "integer",
        description: "Filter to one subnet netuid.",
        minimum: 0,
      },
      profile_level: {
        type: "string",
        enum: PROFILE_LEVELS,
        description: "Filter by profile completeness level.",
      },
      confidence: {
        type: "string",
        enum: CONFIDENCE_LEVELS,
        description: "Filter by confidence level.",
      },
      identity_level: {
        type: "string",
        enum: IDENTITY_LEVELS,
        description: "Filter by subnet identity completeness.",
      },
      identity_promotion_kinds: {
        type: "string",
        enum: SURFACE_KINDS,
        description:
          "Filter rows whose identity promotion kinds include this surface kind.",
      },
      native_name_quality: {
        type: "string",
        enum: NATIVE_NAME_QUALITIES,
        description: "Filter by native name quality.",
      },
      sort: {
        type: "string",
        enum: PROFILE_SORT_FIELDS,
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
          "Comma-separated projection of profile row fields to return.",
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

export const LIST_PROFILE_COMPLETENESS_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: ["profiles"],
  properties: {
    generated_at: NULLABLE_STRING,
    notes: {
      type: ["array", "string", "null"],
      items: { type: "string" },
    },
    summary: { type: ["object", "null"], additionalProperties: true },
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
