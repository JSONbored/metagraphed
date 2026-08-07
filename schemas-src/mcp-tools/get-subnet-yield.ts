// MCP tool `get_subnet_yield`.
// Mirrors GET /api/v1/subnets/{netuid}/yield.
//
// DERIVED FROM THE ROUTE, NOT COPIED (#9796). Each output schema below IS the
// route's own ArtifactSchema, so a route field rename is a compile error here
// instead of silent production drift -- which is what the hand-written copies
// this replaces had already accumulated.
//
// What the copies were publishing:
//   get_subnet_yield: 1 bare `{"type":"object"}` site.
//
// Verified against production before the switch, because deriving is a
// TIGHTENING -- the route schema is stricter than the copy was. Every tool in
// this file was called live and its response validated against the schema it
// now publishes.
import { z } from "zod";
import { netuidSchema } from "./shared.ts";
import { SubnetYieldArtifactSchema } from "../routes/subnet-yield.ts";

export const GetSubnetYieldInputSchema = z
  .object({
    netuid: netuidSchema(),
  })
  .strict();
export type GetSubnetYieldInput = z.infer<typeof GetSubnetYieldInputSchema>;

export const GetSubnetYieldOutputSchema = SubnetYieldArtifactSchema;
export type GetSubnetYieldOutput = z.infer<typeof GetSubnetYieldOutputSchema>;
