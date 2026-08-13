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
import { sectionsSchema } from "../query-params.ts";
import {
  SubnetDetailArtifactSchema,
  SUBNET_DETAIL_SECTIONS,
} from "../routes/subnet-detail.ts";

export const GetSubnetDetailInputSchema = z
  .object({
    netuid: netuidSchema(),
    network: McpNetworkSchema.optional(),
    // #10600. The route publishes this, so the tool has to accept it --
    // validate:mcp-input-parity fails a tool that cannot pass a parameter its
    // own route advertises, on the grounds that an agent reading our contract
    // would send it and be rejected. The bound comes FROM the route's
    // vocabulary rather than being restated, which is the same rule every
    // other shared parameter here follows.
    //
    // Worth more here than on REST: a REST caller pays the unprojected 272,825
    // B in bandwidth, an agent pays it in context window.
    sections: sectionsSchema(SUBNET_DETAIL_SECTIONS, [
      "subnet",
      "economics",
    ]).optional(),
  })
  .strict();
export type GetSubnetDetailInput = z.infer<typeof GetSubnetDetailInputSchema>;

export const GetSubnetDetailOutputSchema = SubnetDetailArtifactSchema;
export type GetSubnetDetailOutput = z.infer<typeof GetSubnetDetailOutputSchema>;
