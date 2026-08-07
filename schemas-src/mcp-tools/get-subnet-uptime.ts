// MCP tool `get_subnet_uptime`.
// Mirrors GET /api/v1/subnets/{netuid}/uptime.
//
// DERIVED FROM THE ROUTE, NOT COPIED (#9796). Each output schema below IS the
// route's own ArtifactSchema, so a route field rename is a compile error here
// instead of silent production drift -- which is what the hand-written copies
// this replaces had already accumulated.
//
// What the copies were publishing:
//   get_subnet_uptime: 2 bare `{"type":"object"}` sites.
//
// Verified against production before the switch, because deriving is a
// TIGHTENING -- the route schema is stricter than the copy was. Every tool in
// this file was called live and its response validated against the schema it
// now publishes.
import { z } from "zod";
import { netuidSchema, windowSchema } from "./shared.ts";
import { UptimeArtifactSchema } from "../routes/health-surfaces.ts";

const UPTIME_WINDOWS = ["90d", "1y"] as const;

export const GetSubnetUptimeInputSchema = z
  .object({
    netuid: netuidSchema(),
    window: windowSchema(UPTIME_WINDOWS).optional(),
    min_samples: z
      .int()
      .min(0)
      .optional()
      .describe(
        "Drop rows computed from fewer than this many samples, so a thin sample cannot look like a trend.",
      )
      .meta({ examples: [10] }),
  })
  .strict();
export type GetSubnetUptimeInput = z.infer<typeof GetSubnetUptimeInputSchema>;

export const GetSubnetUptimeOutputSchema = UptimeArtifactSchema;
export type GetSubnetUptimeOutput = z.infer<typeof GetSubnetUptimeOutputSchema>;
