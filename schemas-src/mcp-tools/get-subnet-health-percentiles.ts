// MCP tool `get_subnet_health_percentiles`.
// Mirrors GET /api/v1/subnets/{netuid}/health/percentiles.
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
import { HealthPercentilesArtifactSchema } from "../routes/health-surfaces.ts";

const HEALTH_WINDOWS = ["7d", "30d"] as const;

export const GetSubnetHealthPercentilesInputSchema = z
  .object({
    netuid: netuidSchema(),
    window: windowSchema(HEALTH_WINDOWS).optional(),
  })
  .strict();
export type GetSubnetHealthPercentilesInput = z.infer<
  typeof GetSubnetHealthPercentilesInputSchema
>;

export const GetSubnetHealthPercentilesOutputSchema =
  HealthPercentilesArtifactSchema;
export type GetSubnetHealthPercentilesOutput = z.infer<
  typeof GetSubnetHealthPercentilesOutputSchema
>;
