// MCP tool `get_subnet_weights`.
// Mirrors GET /api/v1/subnets/{netuid}/weights.
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
import { netuidSchema, windowSchema } from "./shared.ts";
import { SubnetWeightsArtifactSchema } from "../routes/subnet-weights.ts";

const SUBNET_WEIGHTS_WINDOWS = ["7d", "30d"] as const;

export const GetSubnetWeightsInputSchema = z
  .object({
    netuid: netuidSchema(),
    window: windowSchema(SUBNET_WEIGHTS_WINDOWS).optional(),
  })
  .strict();
export type GetSubnetWeightsInput = z.infer<typeof GetSubnetWeightsInputSchema>;

export const GetSubnetWeightsOutputSchema = SubnetWeightsArtifactSchema;
export type GetSubnetWeightsOutput = z.infer<
  typeof GetSubnetWeightsOutputSchema
>;
