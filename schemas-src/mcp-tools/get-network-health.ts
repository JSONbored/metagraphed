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
import { API_QUERY_COLLECTIONS } from "../../src/contracts.ts";
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
  })
  .strict();
export type GetNetworkHealthInput = z.infer<typeof GetNetworkHealthInputSchema>;

export const GetNetworkHealthOutputSchema = HealthSummaryArtifactSchema;
export type GetNetworkHealthOutput = z.infer<
  typeof GetNetworkHealthOutputSchema
>;
