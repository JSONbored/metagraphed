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
import { ROUTE_QUERY_SCHEMAS } from "../route-queries.ts";
import { netuidSchema } from "./shared.ts";
import { HealthIncidentsArtifactSchema } from "../routes/health-surfaces.ts";

const RouteQuery_subnets_netuid_health_incidents =
  ROUTE_QUERY_SCHEMAS["/api/v1/subnets/{netuid}/health/incidents"];

export const GetSubnetHealthIncidentsInputSchema = z
  .object({
    netuid: netuidSchema(),
    window: RouteQuery_subnets_netuid_health_incidents.shape.window,
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
