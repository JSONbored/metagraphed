// MCP tool `get_subnet_idle_stake`.
// Mirrors GET /api/v1/subnets/{netuid}/idle-stake.
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
import { netuidSchema } from "./shared.ts";
import { SubnetIdleStakeArtifactSchema } from "../routes/subnet-idle-stake.ts";

export const GetSubnetIdleStakeInputSchema = z
  .object({
    netuid: netuidSchema(),
  })
  .strict();
export type GetSubnetIdleStakeInput = z.infer<
  typeof GetSubnetIdleStakeInputSchema
>;

export const GetSubnetIdleStakeOutputSchema = SubnetIdleStakeArtifactSchema;
export type GetSubnetIdleStakeOutput = z.infer<
  typeof GetSubnetIdleStakeOutputSchema
>;
