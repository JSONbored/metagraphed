// MCP tool `get_subnet_movers`.
// Mirrors GET /api/v1/subnets/movers.
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
  MOVERS_LIMIT_DEFAULT,
  MOVERS_LIMIT_MAX,
} from "../../src/route-limits.ts";
import { limitSchema, sortSchema, windowSchema } from "./shared.ts";
import { SubnetMoversArtifactSchema } from "../routes/subnet-movers.ts";

const MOVERS_WINDOW_KEYS = ["7d", "30d", "90d"] as const;
const MOVERS_SORTS = ["stake", "emission", "validators", "neurons"] as const;

export const GetSubnetMoversInputSchema = z
  .object({
    window: windowSchema(MOVERS_WINDOW_KEYS).optional(),
    sort: sortSchema(MOVERS_SORTS).optional(),
    limit: limitSchema(MOVERS_LIMIT_MAX, MOVERS_LIMIT_DEFAULT).optional(),
  })
  .strict();
export type GetSubnetMoversInput = z.infer<typeof GetSubnetMoversInputSchema>;

// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note from the pilot batch).
export const GetSubnetMoversOutputSchema = SubnetMoversArtifactSchema;
export type GetSubnetMoversOutput = z.infer<typeof GetSubnetMoversOutputSchema>;
