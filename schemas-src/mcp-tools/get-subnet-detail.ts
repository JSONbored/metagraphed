// MCP tool `get_subnet_detail`.
// Mirrors GET /api/v1/subnets/{netuid}.
//
// DERIVED FROM THE ROUTE, NOT COPIED (#9796). Each output schema below IS the
// route's own ArtifactSchema, so a route field rename is a compile error here
// instead of silent production drift -- which is what the hand-written copies
// this replaces had already accumulated.
//
// What the copies were publishing:
//   get_subnet_detail: 2 bare `{"type":"object"}` sites.
//
// Verified against production before the switch, because deriving is a
// TIGHTENING -- the route schema is stricter than the copy was. Every tool in
// this file was called live and its response validated against the schema it
// now publishes.
import { z } from "zod";
import { netuidSchema } from "./shared.ts";
import { McpNetworkSchema } from "../shared.ts";
import { SubnetDetailArtifactSchema } from "../routes/subnet-detail.ts";

export const GetSubnetDetailInputSchema = z
  .object({
    netuid: netuidSchema(),
    network: McpNetworkSchema.optional(),
  })
  .strict();
export type GetSubnetDetailInput = z.infer<typeof GetSubnetDetailInputSchema>;

export const GetSubnetDetailOutputSchema = SubnetDetailArtifactSchema;
export type GetSubnetDetailOutput = z.infer<typeof GetSubnetDetailOutputSchema>;
