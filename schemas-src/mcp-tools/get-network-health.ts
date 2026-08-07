// MCP tool `get_network_health`.
// Mirrors GET /api/v1/health.
//
// DERIVED FROM THE ROUTE, NOT COPIED (#9796). Each output schema below IS the
// route's own ArtifactSchema, so a route field rename is a compile error here
// instead of silent production drift -- which is what the hand-written copies
// this replaces had already accumulated.
//
// What the copies were publishing:
//   get_network_health: 2 bare `{"type":"object"}` sites.
//
// Verified against production before the switch, because deriving is a
// TIGHTENING -- the route schema is stricter than the copy was. Every tool in
// this file was called live and its response validated against the schema it
// now publishes.
import { z } from "zod";
import { HealthSummaryArtifactSchema } from "../routes/health.ts";

export const GetNetworkHealthInputSchema = z.object({}).strict();
export type GetNetworkHealthInput = z.infer<typeof GetNetworkHealthInputSchema>;

export const GetNetworkHealthOutputSchema = HealthSummaryArtifactSchema;
export type GetNetworkHealthOutput = z.infer<
  typeof GetNetworkHealthOutputSchema
>;
