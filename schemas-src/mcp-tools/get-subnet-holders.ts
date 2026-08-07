// MCP tool `get_subnet_holders`.
// Mirrors GET /api/v1/subnets/{netuid}/holders.
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
import { limitSchema, netuidSchema } from "./shared.ts";
import {
  SUBNET_HOLDERS_LIMIT_DEFAULT,
  SUBNET_HOLDERS_LIMIT_MAX,
} from "../../src/route-limits.ts";
import { SubnetHoldersArtifactSchema } from "../routes/subnet-holders.ts";

export const GetSubnetHoldersInputSchema = z
  .object({
    netuid: netuidSchema(),
    limit: limitSchema(
      SUBNET_HOLDERS_LIMIT_MAX,
      SUBNET_HOLDERS_LIMIT_DEFAULT,
    ).optional(),
  })
  .strict();
export type GetSubnetHoldersInput = z.infer<typeof GetSubnetHoldersInputSchema>;

export const GetSubnetHoldersOutputSchema = SubnetHoldersArtifactSchema;
export type GetSubnetHoldersOutput = z.infer<
  typeof GetSubnetHoldersOutputSchema
>;
