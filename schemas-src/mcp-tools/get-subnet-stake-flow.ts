// MCP tool `get_subnet_stake_flow`.
// Mirrors GET /api/v1/subnets/{netuid}/stake-flow.
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
import { kindSchema, netuidSchema, windowSchema } from "./shared.ts";
import { SubnetStakeFlowArtifactSchema } from "../routes/subnet-stake-flow.ts";
import {
  SUBNET_STAKE_FLOW_FLOW_DIRECTIONS_VALUES,
  SUBNET_STAKE_FLOW_WINDOW_VALUES,
} from "../routes/subnet-stake-flow.ts";

export const GetSubnetStakeFlowInputSchema = z
  .object({
    netuid: netuidSchema(),
    window: windowSchema(SUBNET_STAKE_FLOW_WINDOW_VALUES).optional(),
    direction: kindSchema(SUBNET_STAKE_FLOW_FLOW_DIRECTIONS_VALUES).optional(),
  })
  .strict();
export type GetSubnetStakeFlowInput = z.infer<
  typeof GetSubnetStakeFlowInputSchema
>;

export const GetSubnetStakeFlowOutputSchema = SubnetStakeFlowArtifactSchema;
export type GetSubnetStakeFlowOutput = z.infer<
  typeof GetSubnetStakeFlowOutputSchema
>;
