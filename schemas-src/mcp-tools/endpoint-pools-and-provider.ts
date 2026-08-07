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
  McpListArtifactStamp,
  McpListPageFields,
  fieldsStringSchema,
  kindSchema,
  limitSchema,
  netuidSchema,
  numericCursorSchema,
  orderSchema,
  projectableRows,
  providerSlugSchema,
  sortSchema,
} from "./shared.ts";
import { EndpointPoolsArtifactSchema } from "../routes/endpoints-pools.ts";
import { EndpointIncidentsArtifactSchema } from "../routes/endpoints-pools.ts";
import { ProviderEndpointsArtifactSchema } from "../routes/providers-rpc.ts";
import {
  ENDPOINT_LAYER_VALUES,
  ENDPOINT_PUBLICATION_STATE_VALUES,
  SURFACE_KIND_VALUES,
} from "../routes/subnet-detail.ts";
import { HEALTH_STATUS_VALUES } from "../shared.ts";
import { ENDPOINT_INCIDENT_SEVERITY_VALUES } from "../routes/endpoints-pools.ts";
import { ENDPOINT_POOL_SORT_VALUES, ENDPOINT_SORT_VALUES } from "./shared.ts";

export const ListEndpointPoolsInputSchema = z
  .object({
    id: z
      .string()
      .optional()
      .describe(
        "The record's stable identifier, as returned by the corresponding list tool. Exact match; an unknown id yields an empty result rather than an error.",
      )
      .meta({ examples: ["sn-64-chutes-subnet-api"] }),
    kind: kindSchema(ENDPOINT_LAYER_VALUES).optional(),
    min_eligible_count: z
      .number()
      .optional()
      .describe(
        "Inclusive lower bound on pool-eligible endpoint count; rows below it are excluded.",
      )
      .meta({ examples: [1] }),
    max_eligible_count: z
      .number()
      .optional()
      .describe(
        "Inclusive upper bound on pool-eligible endpoint count; rows above it are excluded.",
      )
      .meta({ examples: [10] }),
    min_endpoint_count: z
      .number()
      .optional()
      .describe(
        "Inclusive lower bound on endpoint count; rows below it are excluded.",
      )
      .meta({ examples: [1] }),
    max_endpoint_count: z
      .number()
      .optional()
      .describe(
        "Inclusive upper bound on endpoint count; rows above it are excluded.",
      )
      .meta({ examples: [10] }),
    sort: sortSchema(ENDPOINT_POOL_SORT_VALUES).optional(),
    order: orderSchema().optional(),
    fields: fieldsStringSchema().optional(),
    limit: limitSchema(100).optional(),
    cursor: numericCursorSchema().optional(),
  })
  .strict();
export type ListEndpointPoolsInput = z.infer<
  typeof ListEndpointPoolsInputSchema
>;

export const ListEndpointPoolsOutputSchema = EndpointPoolsArtifactSchema.pick({
  pools: true,
}).extend({
  pools: projectableRows(EndpointPoolsArtifactSchema.shape.pools),
  ...McpListArtifactStamp,
  ...McpListPageFields,
});
export type ListEndpointPoolsOutput = z.infer<
  typeof ListEndpointPoolsOutputSchema
>;

const SURFACE_KINDS = SURFACE_KIND_VALUES;
const HEALTH_STATUSES = HEALTH_STATUS_VALUES;
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
      .enum(ENDPOINT_INCIDENT_SEVERITY_VALUES)
      .optional()
      .describe("How serious the incident is.")
      .meta({ examples: [ENDPOINT_INCIDENT_SEVERITY_VALUES[0]] }),
    state: z
      .enum(INCIDENT_STATES)
      .optional()
      .describe("The incident's lifecycle state.")
      .meta({ examples: [INCIDENT_STATES[0]] }),
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

export const ListEndpointIncidentsOutputSchema =
  EndpointIncidentsArtifactSchema.pick({
    summary: true,
    incidents: true,
  }).extend({
    incidents: projectableRows(EndpointIncidentsArtifactSchema.shape.incidents),
    ...McpListArtifactStamp,
    ...McpListPageFields,
  });
export type ListEndpointIncidentsOutput = z.infer<
  typeof ListEndpointIncidentsOutputSchema
>;

const ENDPOINT_LAYERS = ENDPOINT_LAYER_VALUES;
const ENDPOINT_PUBLICATION_STATES = ENDPOINT_PUBLICATION_STATE_VALUES;
export const ListProviderEndpointsInputSchema = z
  .object({
    slug: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .describe(
        "The registry slug — lowercase, hyphenated (`chutes`), not the display name. Slugs are stable across renames.",
      )
      .meta({ examples: ["chutes"] }),
    kind: kindSchema(SURFACE_KINDS).optional(),
    layer: z
      .enum(ENDPOINT_LAYERS)
      .optional()
      .describe(
        "Which layer of the stack the endpoint belongs to: the Bittensor base chain, a data or docs provider, or a subnet's own app.",
      )
      .meta({ examples: [ENDPOINT_LAYERS[0]] }),
    netuid: netuidSchema().optional(),
    publication_state: z
      .enum(ENDPOINT_PUBLICATION_STATES)
      .optional()
      .describe(
        "Where the endpoint sits in the review pipeline, from unreviewed candidate through to pool-eligible or rejected.",
      )
      .meta({ examples: [ENDPOINT_PUBLICATION_STATES[0]] }),
    status: kindSchema(HEALTH_STATUSES).optional(),
    pool_eligible: z
      .boolean()
      .optional()
      .describe(
        "Restrict to endpoints that are (or are not) eligible for the public RPC pool.",
      )
      .meta({ examples: [true] }),
    min_latency_ms: z
      .number()
      .optional()
      .describe(
        "Inclusive lower bound on probe latency in milliseconds; rows below it are excluded.",
      )
      .meta({ examples: [50] }),
    max_latency_ms: z
      .number()
      .optional()
      .describe(
        "Inclusive upper bound on probe latency in milliseconds; rows above it are excluded.",
      )
      .meta({ examples: [500] }),
    min_score: z
      .number()
      .optional()
      .describe(
        "Inclusive lower bound on endpoint score; rows below it are excluded.",
      )
      .meta({ examples: [50] }),
    max_score: z
      .number()
      .optional()
      .describe(
        "Inclusive upper bound on endpoint score; rows above it are excluded.",
      )
      .meta({ examples: [100] }),
    sort: sortSchema(ENDPOINT_SORT_VALUES).optional(),
    order: orderSchema().optional(),
    fields: fieldsStringSchema().optional(),
    limit: limitSchema(100).optional(),
    cursor: numericCursorSchema().optional(),
  })
  .strict();
export type ListProviderEndpointsInput = z.infer<
  typeof ListProviderEndpointsInputSchema
>;

export const ListProviderEndpointsOutputSchema =
  ProviderEndpointsArtifactSchema.pick({
    endpoints: true,
  }).extend({
    endpoints: projectableRows(ProviderEndpointsArtifactSchema.shape.endpoints),
    ...McpListArtifactStamp,
    // The handler echoes the requested slug rather than the route
    // artifact's `provider` block: the tool is asked for one provider by
    // slug, so the slug is what identifies the answer.
    slug: z.string(),
    ...McpListPageFields,
  });
export type ListProviderEndpointsOutput = z.infer<
  typeof ListProviderEndpointsOutputSchema
>;
