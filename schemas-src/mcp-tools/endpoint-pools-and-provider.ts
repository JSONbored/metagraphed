// MCP tools `list_endpoint_pools`, `list_endpoint_incidents`,
// `list_provider_endpoints` (types-epic E batch 11, #8074). None are defined
// inline in src/mcp-server.ts -- their `LIST_X_MCP_TOOL`/
// `LIST_X_OUTPUT_SCHEMA` hand-written literals live in
// src/endpoint-pools-mcp.ts, src/endpoint-incidents-mcp.ts, and
// src/provider-endpoints-mcp.ts respectively, imported into mcp-server.ts's
// MCP_TOOLS array via object spread. The z.toJSONSchema(...) wiring for
// these three happens in THEIR OWN files, not mcp-server.ts. None mirror an
// existing schemas-src/routes/ REST schema -- modeled fresh, matching each
// hand-written literal field-for-field. `list_provider_endpoints`' `slug` is
// REQUIRED (a path param, not a filter), unlike every other filter in this
// file.
import { z } from "zod";
import {
  NotesFieldSchema,
  OpenObjectSchema,
  fieldsStringSchema,
  kindSchema,
  limitSchema,
  netuidSchema,
  numericCursorSchema,
  orderSchema,
  providerSlugSchema,
  sortSchema,
} from "./shared.ts";

const POOL_KINDS = ["subtensor-rpc", "subtensor-wss", "archive"] as const;
const POOL_SORT_FIELDS = [
  "eligible_count",
  "endpoint_count",
  "id",
  "kind",
] as const;

export const ListEndpointPoolsInputSchema = z
  .object({
    id: z
      .string()
      .optional()
      .describe(
        "The record's stable identifier, as returned by the corresponding list tool. Exact match; an unknown id yields an empty result rather than an error.",
      ),
    kind: kindSchema(POOL_KINDS).optional(),
    min_eligible_count: z
      .number()
      .optional()
      .describe(
        "Inclusive lower bound on pool-eligible endpoint count; rows below it are excluded.",
      ),
    max_eligible_count: z
      .number()
      .optional()
      .describe(
        "Inclusive upper bound on pool-eligible endpoint count; rows above it are excluded.",
      ),
    min_endpoint_count: z
      .number()
      .optional()
      .describe(
        "Inclusive lower bound on endpoint count; rows below it are excluded.",
      ),
    max_endpoint_count: z
      .number()
      .optional()
      .describe(
        "Inclusive upper bound on endpoint count; rows above it are excluded.",
      ),
    sort: sortSchema(POOL_SORT_FIELDS).optional(),
    order: orderSchema().optional(),
    fields: fieldsStringSchema().optional(),
    limit: limitSchema(100).optional(),
    cursor: numericCursorSchema().optional(),
  })
  .strict();
export type ListEndpointPoolsInput = z.infer<
  typeof ListEndpointPoolsInputSchema
>;

export const ListEndpointPoolsOutputSchema = z
  .object({
    generated_at: z.string().nullable().optional(),
    notes: NotesFieldSchema,
    pools: z.array(OpenObjectSchema),
    total: z.int().optional(),
    returned: z.int().optional(),
    limit: z.int().optional(),
    cursor: z.int().optional(),
    next_cursor: z.int().nullable().optional(),
    sort: z.string().nullable().optional(),
    order: z.string().nullable().optional(),
  })
  .passthrough();
export type ListEndpointPoolsOutput = z.infer<
  typeof ListEndpointPoolsOutputSchema
>;

const SURFACE_KINDS = [
  "archive",
  "dashboard",
  "data-artifact",
  "docs",
  "example",
  "openapi",
  "repo-registry",
  "sdk",
  "source-repo",
  "sse",
  "subnet-api",
  "subtensor-rpc",
  "subtensor-wss",
  "website",
] as const;
const HEALTH_STATUSES = ["ok", "degraded", "failed", "unknown"] as const;
const INCIDENT_SEVERITIES = ["critical", "warning", "info"] as const;
const INCIDENT_STATES = ["active", "resolved"] as const;
const INCIDENT_SORT_FIELDS = [
  "detected_at",
  "endpoint_id",
  "kind",
  "last_checked",
  "netuid",
  "provider",
  "severity",
  "state",
  "status",
] as const;

export const ListEndpointIncidentsInputSchema = z
  .object({
    netuid: netuidSchema().optional(),
    kind: kindSchema(SURFACE_KINDS).optional(),
    provider: providerSlugSchema().optional(),
    status: kindSchema(HEALTH_STATUSES).optional(),
    severity: z
      .enum(INCIDENT_SEVERITIES)
      .optional()
      .describe("How serious the incident is."),
    state: z
      .enum(INCIDENT_STATES)
      .optional()
      .describe("The incident's lifecycle state."),
    sort: sortSchema(INCIDENT_SORT_FIELDS).optional(),
    order: orderSchema().optional(),
    fields: fieldsStringSchema().optional(),
    limit: limitSchema(100).optional(),
    cursor: numericCursorSchema().optional(),
  })
  .strict();
export type ListEndpointIncidentsInput = z.infer<
  typeof ListEndpointIncidentsInputSchema
>;

export const ListEndpointIncidentsOutputSchema = z
  .object({
    generated_at: z.string().nullable().optional(),
    notes: NotesFieldSchema,
    summary: OpenObjectSchema.nullable().optional(),
    incidents: z.array(OpenObjectSchema),
    total: z.int().optional(),
    returned: z.int().optional(),
    limit: z.int().optional(),
    cursor: z.int().optional(),
    next_cursor: z.int().nullable().optional(),
    sort: z.string().nullable().optional(),
    order: z.string().nullable().optional(),
  })
  .passthrough();
export type ListEndpointIncidentsOutput = z.infer<
  typeof ListEndpointIncidentsOutputSchema
>;

const ENDPOINT_LAYERS = [
  "bittensor-base",
  "data-provider",
  "docs-provider",
  "subnet-app",
] as const;
const ENDPOINT_PUBLICATION_STATES = [
  "candidate",
  "verified",
  "monitored",
  "pool-eligible",
  "disabled",
  "rejected",
] as const;
const ENDPOINT_SORT_FIELDS = [
  "kind",
  "last_checked",
  "latency_ms",
  "layer",
  "netuid",
  "pool_eligible",
  "provider",
  "publication_state",
  "score",
  "status",
] as const;

export const ListProviderEndpointsInputSchema = z
  .object({
    slug: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .describe(
        "The registry slug — lowercase, hyphenated (`chutes`), not the display name. Slugs are stable across renames.",
      ),
    kind: kindSchema(SURFACE_KINDS).optional(),
    layer: z
      .enum(ENDPOINT_LAYERS)
      .optional()
      .describe(
        "Which layer of the stack the endpoint belongs to: the Bittensor base chain, a data or docs provider, or a subnet's own app.",
      ),
    netuid: netuidSchema().optional(),
    publication_state: z
      .enum(ENDPOINT_PUBLICATION_STATES)
      .optional()
      .describe(
        "Where the endpoint sits in the review pipeline, from unreviewed candidate through to pool-eligible or rejected.",
      ),
    status: kindSchema(HEALTH_STATUSES).optional(),
    pool_eligible: z
      .boolean()
      .optional()
      .describe(
        "Restrict to endpoints that are (or are not) eligible for the public RPC pool.",
      ),
    min_latency_ms: z
      .number()
      .optional()
      .describe(
        "Inclusive lower bound on probe latency in milliseconds; rows below it are excluded.",
      ),
    max_latency_ms: z
      .number()
      .optional()
      .describe(
        "Inclusive upper bound on probe latency in milliseconds; rows above it are excluded.",
      ),
    min_score: z
      .number()
      .optional()
      .describe(
        "Inclusive lower bound on endpoint score; rows below it are excluded.",
      ),
    max_score: z
      .number()
      .optional()
      .describe(
        "Inclusive upper bound on endpoint score; rows above it are excluded.",
      ),
    sort: sortSchema(ENDPOINT_SORT_FIELDS).optional(),
    order: orderSchema().optional(),
    fields: fieldsStringSchema().optional(),
    limit: limitSchema(100).optional(),
    cursor: numericCursorSchema().optional(),
  })
  .strict();
export type ListProviderEndpointsInput = z.infer<
  typeof ListProviderEndpointsInputSchema
>;

export const ListProviderEndpointsOutputSchema = z
  .object({
    slug: z.string(),
    generated_at: z.string().nullable().optional(),
    notes: NotesFieldSchema,
    endpoints: z.array(OpenObjectSchema),
    total: z.int().optional(),
    returned: z.int().optional(),
    limit: z.int().optional(),
    cursor: z.int().optional(),
    next_cursor: z.int().nullable().optional(),
    sort: z.string().nullable().optional(),
    order: z.string().nullable().optional(),
  })
  .passthrough();
export type ListProviderEndpointsOutput = z.infer<
  typeof ListProviderEndpointsOutputSchema
>;
