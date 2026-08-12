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
import { ENDPOINT_LIST_FILTERS } from "./endpoints-catalog.ts";
import { API_QUERY_COLLECTIONS } from "../../src/contracts.ts";
import {
  McpListPageFields,
  McpSubnetListArtifactStamp,
  kindSchema,
  limitSchema,
  netuidSchema,
  numericCursorSchema,
  orderSchema,
  projectableRows,
  providerSlugSchema,
  sortSchema,
} from "./shared.ts";
import { SubnetEndpointsArtifactSchema } from "../routes/endpoints-pools.ts";
import { SubnetSurfacesArtifactSchema } from "../routes/endpoints-pools.ts";
// #10008: the per-subnet view is this with `netuid` required, so it is derived
// rather than hand-copied -- which is how it came to lack the collection's
// three boolean filters in the first place.
import { ListSurfacesInputSchema } from "./registry-catalogs-1.ts";
import { SURFACE_KIND_VALUES } from "../routes/subnet-detail.ts";
import { HEALTH_STATUS_VALUES } from "../shared.ts";
import { HEALTH_CLASSIFICATION_VALUES } from "./shared.ts";

const SURFACE_KINDS = SURFACE_KIND_VALUES;
const HEALTH_STATUSES = HEALTH_STATUS_VALUES;
export const ListSubnetEndpointsInputSchema = z
  .object({
    ...ENDPOINT_LIST_FILTERS,
    // The subnet-scoped list: netuid is the SUBJECT, not a filter.
    netuid: netuidSchema(),
    limit: limitSchema(100, 20).optional(),
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
    endpoints: projectableRows(SubnetEndpointsArtifactSchema.shape.endpoints),
    ...McpSubnetListArtifactStamp,
    ...McpListPageFields,
  });
export type ListSubnetEndpointsOutput = z.infer<
  typeof ListSubnetEndpointsOutputSchema
>;

/**
 * DERIVED FROM THE NETWORK-WIDE SIBLING (#10008).
 *
 * This was a hand-copy of ListSurfacesInputSchema with `netuid` required --
 * which is why it did not have the three boolean filters the curated-surfaces
 * collection declares, and would not have gained them when that tool did.
 *
 * `fields` is omitted deliberately, not forgotten: the projection contract
 * (#9884) says a tool may serve a partial object only if it advertises
 * `fields`, and this tool's output schema is not partial. Adding it here would
 * publish a projection the response does not honour, so it stays out until
 * that side is converted with it.
 */
export const ListSubnetSurfacesInputSchema = ListSurfacesInputSchema.omit({
  netuid: true,
  fields: true,
})
  .extend({ netuid: netuidSchema() })
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

export const ListSubnetHealthInputSchema = z
  .object({
    netuid: netuidSchema(),
    kind: kindSchema(SURFACE_KINDS).optional(),
    provider: providerSlugSchema().optional(),
    status: kindSchema(HEALTH_STATUSES).optional(),
    classification: API_QUERY_COLLECTIONS[
      "health-surfaces"
    ].filter_schemas.classification
      .optional()
      .describe(
        "Why a probe ended as it did — the reason behind the status, not the status itself.",
      )
      .meta({ examples: [HEALTH_CLASSIFICATION_VALUES[0]] }),
    sort: sortSchema(
      API_QUERY_COLLECTIONS["health-surfaces"].sort_fields,
    ).optional(),
    order: orderSchema().optional(),
    limit: limitSchema(100, 20).optional(),
    cursor: numericCursorSchema().optional(),
  })
  .strict();
export type ListSubnetHealthInput = z.infer<typeof ListSubnetHealthInputSchema>;

// NOT DERIVED, deliberately (#9796), and now MODELED rather than left open
// (#9797). list_subnet_health does not mirror HealthSubnetArtifact's row
// shape: the route serves overlaySubnetHealth()'s live-merged 12-field row
// (strict, and requiring `observed_by`), while the tool serves the registry
// surface record overlaid with health. Re-confirmed against production
// 2026-08-07 -- deriving it fails with `Unrecognized keys: auth_required,
// content_type, method_tested, private_redirect_blocked, public_safe,
// subnet_name, subnet_slug, uptime_sample_ratio, verified_at`, which is that
// difference stated by the validator rather than by a comment.
//
// So this one is modeled from the LIVE RESPONSE, censused across 44 rows from
// four subnets (1, 8, 53, 64) on 2026-08-07. Optionality is measured, not
// guessed: the five fields below marked optional were genuinely absent on some
// rows, and `last_ok` is the one that is present-but-null. Passthrough,
// because a modeled shape should not reject a field the producer adds before
// this file learns about it.
const SubnetHealthSurfaceSchema = z
  .object({
    surface_id: z.string(),
    netuid: netuidSchema(),
    subnet_slug: z.string(),
    subnet_name: z.string(),
    kind: z.string(),
    provider: z.string(),
    url: z.string(),
    auth_required: z.boolean(),
    public_safe: z.boolean(),
    method_tested: z.string(),
    status: z.string(),
    classification: z.string(),
    latency_ms: z.number(),
    last_checked: z.string(),
    // Present on every row, null when the surface has never been seen healthy.
    last_ok: z.string().nullable(),
    verified_at: z.string(),
    uptime_sample_ratio: z.number(),
    private_redirect_blocked: z.boolean(),
    // Absent rather than null when the probe did not record one: 43/44 rows
    // carried a status_code and content_type, 1/44 an error/error_class, 4/44
    // a redirect_target.
    status_code: z.int().optional(),
    content_type: z.string().optional(),
    error: z.string().optional(),
    error_class: z.string().optional(),
    redirect_target: z.string().optional(),
  })
  .strict();
export const ListSubnetHealthOutputSchema = z
  .object({
    generated_at: z.string().nullable().optional(),
    netuid: netuidSchema().nullable().optional(),
    surfaces: z.array(SubnetHealthSurfaceSchema),
    total: z.int().optional(),
    returned: z.int().optional(),
    limit: z.int().optional(),
    cursor: z.int().optional(),
    next_cursor: z.int().nullable().optional(),
    sort: z.string().nullable().optional(),
    order: z.string().nullable().optional(),
  })
  .strict();
export type ListSubnetHealthOutput = z.infer<
  typeof ListSubnetHealthOutputSchema
>;
