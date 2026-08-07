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
import {
  BulkHealthTrendsArtifactSchema,
  BulkHealthTrendsQuerySchema,
  HEALTH_TREND_WINDOW_VALUES,
} from "../routes/health-surfaces.ts";
import { limitSchema, offsetSchema } from "./shared.ts";

/**
 * DERIVED FROM THE ROUTE'S QUERY SCHEMA, NOT COPIED (#9981).
 *
 * This tool took NO arguments and returned ~487 KB -- not bad defaults, but no
 * way to narrow the request at all, because the route it mirrors had no query
 * parameters either. Both now do, and the shape is the route's:
 * `BulkHealthTrendsQuerySchema` owns which parameters exist and their bounds,
 * and this re-describes them for an agent audience without being free to
 * disagree about them.
 *
 * Output schemas have been derived from routes since #9796; input schemas were
 * still declared twice. This is the same rule applied to the other direction.
 */
export const GetHealthTrendsInputSchema = BulkHealthTrendsQuerySchema.extend({
  window: z
    .enum(HEALTH_TREND_WINDOW_VALUES)
    .optional()
    .describe(
      "Return only this window instead of every one. Halves the response and " +
        "narrows the query behind it -- a 7d request stops reading 30 days of " +
        "rows to discard 23. Omit for every window.",
    )
    .meta({ examples: ["7d"] }),
  limit: limitSchema(512).optional(),
  offset: offsetSchema().optional(),
}).strict();
export type GetHealthTrendsInput = z.infer<typeof GetHealthTrendsInputSchema>;

export const GetHealthTrendsOutputSchema = BulkHealthTrendsArtifactSchema;
export type GetHealthTrendsOutput = z.infer<typeof GetHealthTrendsOutputSchema>;
