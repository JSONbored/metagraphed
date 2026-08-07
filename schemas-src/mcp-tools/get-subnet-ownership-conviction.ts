// MCP tools `get_subnet_conviction`, `get_subnet_ownership_history`.
// Mirror GET /api/v1/subnets/{netuid}/conviction, GET
// /api/v1/subnets/{netuid}/ownership-history.
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
import { SubnetConvictionArtifactSchema } from "../routes/subnet-conviction.ts";
import { SubnetOwnershipHistoryArtifactSchema } from "../routes/subnet-ownership-history.ts";

export const GetSubnetOwnershipHistoryInputSchema = z
  .object({
    netuid: netuidSchema(),
  })
  .strict();
export type GetSubnetOwnershipHistoryInput = z.infer<
  typeof GetSubnetOwnershipHistoryInputSchema
>;

export const GetSubnetOwnershipHistoryOutputSchema =
  SubnetOwnershipHistoryArtifactSchema;
export type GetSubnetOwnershipHistoryOutput = z.infer<
  typeof GetSubnetOwnershipHistoryOutputSchema
>;

export const GetSubnetConvictionInputSchema = z
  .object({
    netuid: netuidSchema(),
  })
  .strict();
export type GetSubnetConvictionInput = z.infer<
  typeof GetSubnetConvictionInputSchema
>;

export const GetSubnetConvictionOutputSchema = SubnetConvictionArtifactSchema;
export type GetSubnetConvictionOutput = z.infer<
  typeof GetSubnetConvictionOutputSchema
>;
