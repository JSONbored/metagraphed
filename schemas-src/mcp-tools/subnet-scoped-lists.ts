// MCP tools `list_subnet_endpoints`, `list_subnet_surfaces`,
// `list_subnet_health` (types-epic E batch 9, #8073). Like
// registry-catalogs-{1,2}.ts's tools, these three are NOT defined inline in
// src/mcp-server.ts -- their `LIST_X_MCP_TOOL`/`LIST_X_OUTPUT_SCHEMA`
// hand-written literals live in src/subnet-endpoints-mcp.ts,
// src/subnet-surfaces-mcp.ts, and src/subnet-health-mcp.ts respectively,
// imported into mcp-server.ts's MCP_TOOLS array via object spread. The
// z.toJSONSchema(...) wiring for these three happens in THEIR OWN files, not
// mcp-server.ts. None mirror an existing schemas-src/routes/ REST schema --
// modeled fresh, matching each hand-written literal field-for-field. Unlike
// the network-wide list_* tools in registry-catalogs-{1,2}.ts, `netuid` is
// REQUIRED here (a path parameter, not a filter), and none of the three
// output shapes carry schema_version/notes/summary. list_subnet_endpoints'
// `pool_eligible` is a STRING enum (["true","false"]), unlike
// list_rpc_endpoints' plain boolean for the same filter name.
// list_subnet_surfaces/list_subnet_health have no `fields` projection param
// at all, unlike every other list_* tool in this epic.
import { z } from "zod";
import {
  McpListPageFields,
  McpSubnetListArtifactStamp,
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
import { SubnetEndpointsArtifactSchema } from "../routes/endpoints-pools.ts";
import { SubnetSurfacesArtifactSchema } from "../routes/endpoints-pools.ts";
import {
  ENDPOINT_LAYER_VALUES,
  ENDPOINT_PUBLICATION_STATE_VALUES,
  SURFACE_KIND_VALUES,
} from "../routes/subnet-detail.ts";
import { HEALTH_STATUS_VALUES } from "../shared.ts";

const SURFACE_KINDS = SURFACE_KIND_VALUES;
const ENDPOINT_LAYERS = ENDPOINT_LAYER_VALUES;
const ENDPOINT_PUBLICATION_STATES = ENDPOINT_PUBLICATION_STATE_VALUES;
const HEALTH_STATUSES = HEALTH_STATUS_VALUES;
const BOOLEAN_STRINGS = ["true", "false"] as const;
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

export const ListSubnetEndpointsInputSchema = z
  .object({
    netuid: netuidSchema(),
    kind: kindSchema(SURFACE_KINDS).optional(),
    layer: z
      .enum(ENDPOINT_LAYERS)
      .optional()
      .describe(
        "Which layer of the stack the endpoint belongs to: the Bittensor base chain, a data or docs provider, or a subnet's own app.",
      )
      .meta({ examples: [ENDPOINT_LAYERS[0]] }),
    provider: providerSlugSchema().optional(),
    publication_state: z
      .enum(ENDPOINT_PUBLICATION_STATES)
      .optional()
      .describe(
        "Where the endpoint sits in the review pipeline, from unreviewed candidate through to pool-eligible or rejected.",
      )
      .meta({ examples: [ENDPOINT_PUBLICATION_STATES[0]] }),
    status: kindSchema(HEALTH_STATUSES).optional(),
    pool_eligible: z
      .enum(BOOLEAN_STRINGS)
      .optional()
      .describe(
        "Restrict to endpoints that are (or are not) eligible for the public RPC pool.",
      )
      .meta({ examples: [BOOLEAN_STRINGS[0]] }),
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
    sort: sortSchema(ENDPOINT_SORT_FIELDS).optional(),
    order: orderSchema().optional(),
    fields: fieldsStringSchema().optional(),
    limit: limitSchema(100).optional(),
    cursor: numericCursorSchema().optional(),
  })
  .strict();
export type ListSubnetEndpointsInput = z.infer<
  typeof ListSubnetEndpointsInputSchema
>;

export const ListSubnetEndpointsOutputSchema =
  SubnetEndpointsArtifactSchema.pick({
    netuid: true,
    endpoints: true,
  }).extend({
    ...McpSubnetListArtifactStamp,
    ...McpListPageFields,
  });
export type ListSubnetEndpointsOutput = z.infer<
  typeof ListSubnetEndpointsOutputSchema
>;

const SURFACE_SORT_FIELDS = [
  "id",
  "kind",
  "name",
  "netuid",
  "provider",
] as const;

export const ListSubnetSurfacesInputSchema = z
  .object({
    netuid: netuidSchema(),
    kind: kindSchema(SURFACE_KINDS).optional(),
    provider: providerSlugSchema().optional(),
    id: z
      .string()
      .optional()
      .describe(
        "The record's stable identifier, as returned by the corresponding list tool. Exact match; an unknown id yields an empty result rather than an error.",
      )
      .meta({ examples: ["sn-64-chutes-subnet-api"] }),
    sort: sortSchema(SURFACE_SORT_FIELDS).optional(),
    order: orderSchema().optional(),
    limit: limitSchema(100).optional(),
    cursor: numericCursorSchema().optional(),
  })
  .strict();
export type ListSubnetSurfacesInput = z.infer<
  typeof ListSubnetSurfacesInputSchema
>;

export const ListSubnetSurfacesOutputSchema = SubnetSurfacesArtifactSchema.pick(
  {
    netuid: true,
    surfaces: true,
  },
).extend({
  ...McpSubnetListArtifactStamp,
  ...McpListPageFields,
});
export type ListSubnetSurfacesOutput = z.infer<
  typeof ListSubnetSurfacesOutputSchema
>;

const HEALTH_CLASSIFICATIONS = [
  "auth-required",
  "content-mismatch",
  "dead",
  "live",
  "rate-limited",
  "redirected",
  "timeout",
  "transient",
  "unsupported",
  "unsafe",
  "wrong-chain",
] as const;
const HEALTH_SORT_FIELDS = [
  "classification",
  "kind",
  "last_checked",
  "last_ok",
  "latency_ms",
  "netuid",
  "provider",
  "status",
  "status_code",
  "surface_id",
  "verified_at",
] as const;

export const ListSubnetHealthInputSchema = z
  .object({
    netuid: netuidSchema(),
    kind: kindSchema(SURFACE_KINDS).optional(),
    provider: providerSlugSchema().optional(),
    status: kindSchema(HEALTH_STATUSES).optional(),
    classification: z
      .enum(HEALTH_CLASSIFICATIONS)
      .optional()
      .describe(
        "Why a probe ended as it did — the reason behind the status, not the status itself.",
      )
      .meta({ examples: [HEALTH_CLASSIFICATIONS[0]] }),
    sort: sortSchema(HEALTH_SORT_FIELDS).optional(),
    order: orderSchema().optional(),
    limit: limitSchema(100).optional(),
    cursor: numericCursorSchema().optional(),
  })
  .strict();
export type ListSubnetHealthInput = z.infer<typeof ListSubnetHealthInputSchema>;

// NOT DERIVED, deliberately (#9796). list_subnet_health does not mirror
// HealthSubnetArtifact's row shape: the route serves overlaySubnetHealth()'s
// live-merged 12-field row (strict, and requiring `observed_by`), while the
// tool serves the registry surface record overlaid with health -- 20 fields,
// including auth_required/public_safe/content_type/method_tested that the
// route row has no place for. Verified against production: deriving it would
// publish a contract the live response violates. It stays hand-written until
// something types the tool's own row (#9797).
export const ListSubnetHealthOutputSchema = z
  .object({
    generated_at: z.string().nullable().optional(),
    netuid: netuidSchema().nullable().optional(),
    surfaces: z.array(OpenObjectSchema),
    total: z.int().optional(),
    returned: z.int().optional(),
    limit: z.int().optional(),
    cursor: z.int().optional(),
    next_cursor: z.int().nullable().optional(),
    sort: z.string().nullable().optional(),
    order: z.string().nullable().optional(),
  })
  .passthrough();
export type ListSubnetHealthOutput = z.infer<
  typeof ListSubnetHealthOutputSchema
>;
