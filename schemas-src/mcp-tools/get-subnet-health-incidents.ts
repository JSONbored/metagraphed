// MCP tool `get_subnet_health_incidents`.
// Mirrors GET /api/v1/subnets/{netuid}/health/incidents.
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
import { HealthIncidentsArtifactSchema } from "../routes/health-surfaces.ts";

const HEALTH_WINDOWS = ["7d", "30d"] as const;

export const GetSubnetHealthIncidentsInputSchema = z
  .object({
    netuid: netuidSchema(),
    window: windowSchema(HEALTH_WINDOWS).optional(),
  })
  .strict();
export type GetSubnetHealthIncidentsInput = z.infer<
  typeof GetSubnetHealthIncidentsInputSchema
>;

export const GetSubnetHealthIncidentsOutputSchema =
  HealthIncidentsArtifactSchema;
export type GetSubnetHealthIncidentsOutput = z.infer<
  typeof GetSubnetHealthIncidentsOutputSchema
>;
