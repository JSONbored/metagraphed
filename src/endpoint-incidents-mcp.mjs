// Endpoint incident list loader for MCP parity on GET /api/v1/endpoint-incidents.
// Applies the same list-query transforms as the REST route over the baked
// /metagraph/endpoint-incidents.json artifact.

import { applyQueryFilters } from "../workers/list-query.mjs";
import { API_QUERY_COLLECTIONS, QUERY_ENUMS } from "./contracts.mjs";

export const ENDPOINT_INCIDENTS_ARTIFACT = "/metagraph/endpoint-incidents.json";

const INCIDENT_SORT_FIELDS =
  API_QUERY_COLLECTIONS["endpoint-incidents"].sort_fields;
const SURFACE_KINDS = QUERY_ENUMS.surfaceKind;
const HEALTH_STATUSES = QUERY_ENUMS.healthStatus;
const INCIDENT_SEVERITIES = QUERY_ENUMS.endpointIncidentSeverity;
const INCIDENT_STATES = QUERY_ENUMS.endpointIncidentState;

export function endpointIncidentsMcpError(code, message) {
  const error = new Error(message);
  error.toolError = true;
  error.code = code;
  return error;
}

function optionalString(args, key) {
  const value = args?.[key];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim() === "") {
    throw endpointIncidentsMcpError(
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
    throw endpointIncidentsMcpError(
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

export function endpointIncidentsQueryUrl(args) {
  const url = new URL("https://mcp.internal/endpoint-incidents");
  if (args?.netuid !== undefined) {
    if (!Number.isInteger(args.netuid) || args.netuid < 0) {
      throw endpointIncidentsMcpError(
        "invalid_params",
        "netuid must be a non-negative integer.",
      );
    }
    url.searchParams.set("netuid", String(args.netuid));
  }
  const kind = optionalEnum(args, "kind", SURFACE_KINDS);
  if (kind) url.searchParams.set("kind", kind);
  const provider = optionalString(args, "provider");
  if (provider) url.searchParams.set("provider", provider);
  const status = optionalEnum(args, "status", HEALTH_STATUSES);
  if (status) url.searchParams.set("status", status);
  const severity = optionalEnum(args, "severity", INCIDENT_SEVERITIES);
  if (severity) url.searchParams.set("severity", severity);
  const state = optionalEnum(args, "state", INCIDENT_STATES);
  if (state) url.searchParams.set("state", state);
  const sort = optionalEnum(args, "sort", INCIDENT_SORT_FIELDS);
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
      throw endpointIncidentsMcpError(
        "invalid_params",
        "cursor must be a non-negative integer.",
      );
    }
    url.searchParams.set("cursor", String(args.cursor));
  }
  return url;
}

export async function loadEndpointIncidentsList(
  ctx,
  args,
  { readArtifact } = {},
) {
  const queryUrl = endpointIncidentsQueryUrl(args);
  const read = readArtifact ?? ctx.readArtifact;
  const result = await read(ctx.env, ENDPOINT_INCIDENTS_ARTIFACT);
  if (!result?.ok) {
    const code = result?.code || "artifact_unavailable";
    if (code === "artifact_not_found") {
      throw endpointIncidentsMcpError(
        "not_found",
        "Endpoint incident snapshot unavailable.",
      );
    }
    throw endpointIncidentsMcpError(
      code,
      `Could not load ${ENDPOINT_INCIDENTS_ARTIFACT} (${code}).`,
    );
  }
  const blob = result.data;
  if (!blob || typeof blob !== "object") {
    throw endpointIncidentsMcpError(
      "not_found",
      "Endpoint incident snapshot unavailable.",
    );
  }
  const transformed = applyQueryFilters(
    blob,
    queryUrl,
    "endpoint-incidents",
    [],
  );
  if (transformed.error) {
    throw endpointIncidentsMcpError(
      "invalid_params",
      transformed.error.message,
    );
  }
  const { data, meta } = transformed;
  const page = meta.pagination || {};
  const rows = Array.isArray(data.incidents) ? data.incidents : [];
  const rowLen = rows.length;
  return {
    generated_at: data.generated_at ?? null,
    notes: data.notes ?? null,
    summary: data.summary ?? null,
    incidents: rows,
    total: page.total ?? rowLen,
    returned: page.returned ?? rowLen,
    limit: page.limit ?? rowLen,
    cursor: page.cursor ?? 0,
    next_cursor: page.next_cursor ?? null,
    sort: page.sort ?? null,
    order: page.order ?? null,
  };
}

export const LIST_ENDPOINT_INCIDENTS_INSTRUCTIONS =
  "list_endpoint_incidents probe-derived endpoint incident feed (severity, state; " +
  "mirrors GET /api/v1/endpoint-incidents), ";

export const LIST_ENDPOINT_INCIDENTS_MCP_TOOL = {
  name: "list_endpoint_incidents",
  title: "List endpoint incidents",
  description:
    "Fetch probe-derived endpoint incidents from the registry: active endpoint " +
    "failures and degradations with severity, state, provider, subnet, and probe " +
    "metadata. Filter by netuid, kind, provider, status, severity, or state; sort " +
    "with sort + order; and page with limit (1-100) / cursor. Complements " +
    "list_endpoints (the full catalog) and get_global_incidents (registry-wide " +
    "operational incidents). Mirrors GET /api/v1/endpoint-incidents.",
  inputSchema: {
    type: "object",
    properties: {
      netuid: {
        type: "integer",
        description: "Filter to one subnet netuid.",
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
      severity: {
        type: "string",
        enum: INCIDENT_SEVERITIES,
        description: "Filter by incident severity.",
      },
      state: {
        type: "string",
        enum: INCIDENT_STATES,
        description: "Filter by incident state.",
      },
      sort: {
        type: "string",
        enum: INCIDENT_SORT_FIELDS,
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
          "Comma-separated projection of incident row fields to return.",
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

export const LIST_ENDPOINT_INCIDENTS_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: ["incidents"],
  properties: {
    generated_at: NULLABLE_STRING,
    notes: {
      type: ["array", "string", "null"],
      items: { type: "string" },
    },
    summary: { type: ["object", "null"] },
    incidents: { type: "array", items: { type: "object" } },
    total: { type: "integer" },
    returned: { type: "integer" },
    limit: { type: "integer" },
    cursor: { type: "integer" },
    next_cursor: NULLABLE_INT,
    sort: NULLABLE_STRING,
    order: NULLABLE_STRING,
  },
};
