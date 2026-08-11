// MCP tool `get_network_health`.
// Mirrors GET /api/v1/health.
//
// DERIVED FROM THE ROUTE, NOT COPIED (#9796). Each output schema below IS the
// route's own ArtifactSchema, so a route field rename is a compile error here
// instead of silent production drift -- which is what the hand-written copies
// this replaces had already accumulated.
//
// What the copies were publishing:
//   get_network_health: 2 bare `{"type":"object"}` sites.
//
// Verified against production before the switch, because deriving is a
// TIGHTENING -- the route schema is stricter than the copy was. Every tool in
// this file was called live and its response validated against the schema it
// now publishes.
import { z } from "zod";
import { MAX_LIMIT } from "../../workers/request-params.ts";
import { MCP_LIST_LIMIT_DEFAULT } from "../../src/route-limits.ts";
import { API_QUERY_COLLECTIONS } from "../../src/contracts.ts";
import {
  limitSchema,
  offsetSchema,
  orderSchema,
  sortSchema,
  McpUnsortedPageFields,
} from "./shared.ts";
import { HealthSummaryArtifactSchema } from "../routes/health.ts";

/**
 * #10014. This took NO arguments -- not even `netuid` -- and returned every
 * subnet's operational health on every call, while GET /api/v1/health
 * publishes both filters below. Same shape get_coverage_depth had before
 * #10011.
 *
 * The status vocabulary is the route's own, so a status added to the health
 * model cannot become one this tool rejects.
 */
export const GetNetworkHealthInputSchema = z
  .object({
    netuid: API_QUERY_COLLECTIONS["health-subnets"].filter_schemas.netuid
      .optional()
      .describe("Restrict to one subnet's health row.")
      .meta({ examples: [64] }),
    status: API_QUERY_COLLECTIONS["health-subnets"].filter_schemas.status
      .optional()
      .describe(
        "Restrict to subnets in this operational state. `failed` is the one an alerting caller usually wants; `unknown` means unprobed, which is NOT the same as healthy.",
      )
      .meta({ examples: ["failed"] }),
    // The page the route publishes and this tool could not pass (#10797).
    //
    // The handler ALREADY pages: it runs applySubnetListQuery over the
    // `health-subnets` collection with no explicit default, which
    // applyMcpQueryFilters then serves at MCP_LIST_LIMIT_DEFAULT. So a caller
    // was getting 20 of the network's ~129 health rows with no argument that
    // could say otherwise, and no `limit` in the schema to reveal that a
    // narrowing had happened at all. Exposing it is the only change here --
    // the default is what it already was, which is why both numbers come from
    // the constants that decide them rather than from literals restated here.
    limit: limitSchema(MAX_LIMIT, MCP_LIST_LIMIT_DEFAULT).optional(),
    // Integer OFFSET, matching what the route publishes
    // (`{minimum: 0, type: integer}`). Added alongside `limit` deliberately: a
    // page size with no way to advance is a narrowing dressed as a capability.
    cursor: offsetSchema().optional(),
    // The collection's own sort list, so a column added to the health model
    // cannot become one this tool rejects.
    sort: sortSchema(
      API_QUERY_COLLECTIONS["health-subnets"].sort_fields,
    ).optional(),
    order: orderSchema().optional(),
  })
  .strict();
export type GetNetworkHealthInput = z.infer<typeof GetNetworkHealthInputSchema>;

export const GetNetworkHealthOutputSchema = HealthSummaryArtifactSchema.extend({
  // The page block the MCP loader adds on top of the route's artifact --
  // undeclared until #10790, when `.strict()` first rejected it.
  ...McpUnsortedPageFields,
});
export type GetNetworkHealthOutput = z.infer<
  typeof GetNetworkHealthOutputSchema
>;
