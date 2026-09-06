// MCP tools `list_endpoints`, `get_subnet_endpoints`.
// Mirror GET /api/v1/endpoints, GET /api/v1/subnets/{netuid}/endpoints.
//
// DERIVED FROM THE ROUTE, NOT COPIED (#9796). Each output schema below IS the
// route's own ArtifactSchema, so a route field rename is a compile error here
// instead of silent production drift -- which is what the hand-written copies
// this replaces had already accumulated.
//
// What the copies were publishing:
//   list_endpoints: 1 bare `{"type":"object"}` site.
//   get_subnet_endpoints: 1 bare `{"type":"object"}` site.
//
// Verified against production before the switch, because deriving is a
// TIGHTENING -- the route schema is stricter than the copy was. Every tool in
// this file was called live and its response validated against the schema it
// now publishes.
import { z } from "zod";
import { API_QUERY_COLLECTIONS } from "../../src/contracts.ts";
import {
  fieldsSchema,
  querySchema,
  kindSchema,
  limitSchema,
  netuidSchema,
  numericCursorSchema,
  orderSchema,
  projectableRows,
  providerSlugSchema,
  sortSchema,
  McpListPageFields,
  McpUnsortedPageFields,
} from "./shared.ts";
import {
  EndpointsArtifactSchema,
  SubnetEndpointsArtifactSchema,
} from "../routes/endpoints-pools.ts";
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

/**
 * The endpoint list-query FILTERS, declared once for their three callers
 * (#10790).
 *
 * `list_endpoints`, `list_provider_endpoints` and `list_subnet_endpoints` share
 * every filter, sort and projection argument. What they do NOT share is
 * `netuid` -- an optional FILTER on the network-wide list, the required SUBJECT
 * on the subnet-scoped one -- or their limit ceilings. Same key set, and on
 * that one key a genuinely different argument, so it stays declared per site
 * where the difference is visible instead of being averaged away.
 */
export const ENDPOINT_LIST_FILTERS = {
  q: querySchema().optional(),
  known_status: z
    .boolean()
    .optional()
    .describe(
      API_QUERY_COLLECTIONS.endpoints.filter_schemas.known_status.description!,
    )
    .meta({ examples: [true] }),
  kind: kindSchema(SURFACE_KINDS).optional(),
  layer: z
    .enum(ENDPOINT_LAYERS)
    .optional()
    .describe(
      "Which layer of the stack the endpoint belongs to: the Bittensor base chain, a data or docs provider, or a subnet's own app.",
    )
    .meta({ examples: [ENDPOINT_LAYERS[0]] }),
  provider: providerSlugSchema().optional(),
  publication_state:
    API_QUERY_COLLECTIONS.endpoints.filter_schemas.publication_state
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
  sort: sortSchema(API_QUERY_COLLECTIONS.endpoints.sort_fields).optional(),
  order: orderSchema().optional(),
  fields: fieldsSchema().optional(),
  // Ceiling is MAX_LIMIT (workers/request-params.ts:21); a literal here
  // because schemas-src/ imports from neither src/ nor workers/.
};

export const ListEndpointsInputSchema = z
  .object({
    ...ENDPOINT_LIST_FILTERS,
    // The network-wide list: netuid NARROWS the result set.
    netuid: API_QUERY_COLLECTIONS.endpoints.filter_schemas.netuid.optional(),
    // Ceiling is MAX_LIMIT (workers/request-params.ts:21); a literal here
    // because schemas-src/ imports from neither src/ nor workers/.
    limit: limitSchema(1000, 20).optional(),
    cursor: numericCursorSchema().optional(),
  })
  .strict();
export type ListEndpointsInput = z.infer<typeof ListEndpointsInputSchema>;

export const ListEndpointsOutputSchema = EndpointsArtifactSchema.extend({
  // The page block the MCP loader adds on top of the route's artifact --
  // undeclared until #10790, when `.strict()` first rejected it.
  ...McpListPageFields,
  endpoints: projectableRows(EndpointsArtifactSchema.shape.endpoints),
});
export type ListEndpointsOutput = z.infer<typeof ListEndpointsOutputSchema>;

/**
 * DERIVED FROM THE NETWORK-WIDE SIBLING, NOT DECLARED FRESH (#9998).
 *
 * This took `netuid` alone, so an agent could not filter a subnet's endpoints
 * by anything -- not by kind, not by status, not even page them -- while any
 * REST caller could. That is also why the tool was 192 KB: it could not pass a
 * `limit`.
 *
 * The per-subnet view is the network-wide one with `netuid` moved from an
 * optional FILTER to the required SUBJECT, so it is expressed that way rather
 * than restating eleven filters that would then be free to drift.
 */
export const GetSubnetEndpointsInputSchema = ListEndpointsInputSchema.omit({
  netuid: true,
})
  .extend({ netuid: netuidSchema() })
  .strict();
export type GetSubnetEndpointsInput = z.infer<
  typeof GetSubnetEndpointsInputSchema
>;

// #10064 production sweep: this tool advertises `fields`, so a caller can ask
// for a SUBSET of each row -- and the artifact schema requires every property
// on it. Production answered `?fields=` with rows that failed the tool's own
// published schema; `projectableRows` is the convention the sibling tools
// already use. Field names and types still come from the route, so a rename
// there is still a compile error here; only requiredness changes, because the
// caller controls it.
export const GetSubnetEndpointsOutputSchema =
  SubnetEndpointsArtifactSchema.extend({
    // The page block the MCP loader adds on top of the route's artifact --
    // undeclared until #10790, when `.strict()` first rejected it.
    ...McpUnsortedPageFields,
    endpoints: projectableRows(SubnetEndpointsArtifactSchema.shape.endpoints),
  });
export type GetSubnetEndpointsOutput = z.infer<
  typeof GetSubnetEndpointsOutputSchema
>;
