// MCP tool `get_health_trends`.
// Mirrors GET /api/v1/health/trends.
//
// DERIVED FROM THE ROUTE, NOT COPIED (#9796). Each output schema below IS the
// route's own ArtifactSchema, so a route field rename is a compile error here
// instead of silent production drift -- which is what the hand-written copies
// this replaces had already accumulated.
//
// What the copies were publishing:
//   get_health_trends: 1 bare `{"type":"object"}` site.
//
// Verified against production before the switch, because deriving is a
// TIGHTENING -- the route schema is stricter than the copy was. Every tool in
// this file was called live and its response validated against the schema it
// now publishes.
import { z } from "zod";
import { BulkHealthTrendsArtifactSchema } from "../routes/health-surfaces.ts";

export const GetHealthTrendsInputSchema = z.object({}).strict();
export type GetHealthTrendsInput = z.infer<typeof GetHealthTrendsInputSchema>;

export const GetHealthTrendsOutputSchema = BulkHealthTrendsArtifactSchema;
export type GetHealthTrendsOutput = z.infer<typeof GetHealthTrendsOutputSchema>;
