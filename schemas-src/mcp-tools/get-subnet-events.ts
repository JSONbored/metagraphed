// MCP tool `get_subnet_events`.
// Mirrors GET /api/v1/subnets/{netuid}/events.
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
import {
  blockBoundSchema,
  keysetCursorSchema,
  kindStringSchema,
  limitSchema,
  netuidSchema,
  offsetSchema,
} from "./shared.ts";
import { SubnetEventsArtifactSchema } from "../routes/subnet-events.ts";

export const GetSubnetEventsInputSchema = z
  .object({
    netuid: netuidSchema(),
    kind: kindStringSchema().optional(),
    block_start: blockBoundSchema("first").optional(),
    block_end: blockBoundSchema("last").optional(),
    limit: limitSchema(1000).optional(),
    offset: offsetSchema().optional(),
    cursor: keysetCursorSchema().optional(),
  })
  .strict();
export type GetSubnetEventsInput = z.infer<typeof GetSubnetEventsInputSchema>;

// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note from the pilot batch).
export const GetSubnetEventsOutputSchema = SubnetEventsArtifactSchema;
export type GetSubnetEventsOutput = z.infer<typeof GetSubnetEventsOutputSchema>;
