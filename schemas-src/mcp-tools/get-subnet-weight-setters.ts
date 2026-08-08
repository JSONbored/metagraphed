// MCP tool `get_subnet_weight_setters`.
// Mirrors GET /api/v1/subnets/{netuid}/weights/setters.
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
import { SubnetWeightSettersArtifactSchema } from "../routes/subnet-weights.ts";

const RouteQuery_subnets_netuid_weights_setters =
  ROUTE_QUERY_SCHEMAS["/api/v1/subnets/{netuid}/weights/setters"];

export const GetSubnetWeightSettersInputSchema = z
  .object({
    netuid: netuidSchema(),
    window: RouteQuery_subnets_netuid_weights_setters.shape.window,
  })
  .strict();
export type GetSubnetWeightSettersInput = z.infer<
  typeof GetSubnetWeightSettersInputSchema
>;

// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note from the pilot batch).
export const GetSubnetWeightSettersOutputSchema =
  SubnetWeightSettersArtifactSchema;
export type GetSubnetWeightSettersOutput = z.infer<
  typeof GetSubnetWeightSettersOutputSchema
>;
