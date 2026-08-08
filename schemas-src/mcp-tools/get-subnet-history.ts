// MCP tool `get_subnet_history`.
// Mirrors GET /api/v1/subnets/{netuid}/history.
//
// DERIVED FROM THE ROUTE, NOT COPIED (#9796). Each output schema below IS the
// route's own ArtifactSchema, so a route field rename is a compile error here
// instead of silent production drift -- which is what the hand-written copies
// this replaces had already accumulated.
//
// Verified against production before the switch, because deriving is a
// TIGHTENING -- the route schema is stricter than the copy was. Every tool in
// this file was called live and its response validated against the schema it
// now publishes.
import { z } from "zod";
import { ROUTE_QUERY_SCHEMAS } from "../route-queries.ts";
import { netuidSchema } from "./shared.ts";
import { SubnetHistoryArtifactSchema } from "../routes/subnet-history.ts";

const RouteQuery_subnets_netuid_history =
  ROUTE_QUERY_SCHEMAS["/api/v1/subnets/{netuid}/history"];

export const GetSubnetHistoryInputSchema = z
  .object({
    netuid: netuidSchema(),
    window: RouteQuery_subnets_netuid_history.shape.window,
  })
  .strict();
export type GetSubnetHistoryInput = z.infer<typeof GetSubnetHistoryInputSchema>;

// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note from the pilot batch).
export const GetSubnetHistoryOutputSchema = SubnetHistoryArtifactSchema;
export type GetSubnetHistoryOutput = z.infer<
  typeof GetSubnetHistoryOutputSchema
>;
