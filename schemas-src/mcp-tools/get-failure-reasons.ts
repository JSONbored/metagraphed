// MCP tool `get_failure_reasons`.
// Mirrors GET /api/v1/health/failure-reasons.
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
import { kindStringSchema, netuidSchema } from "./shared.ts";
import { FAILURE_REASONS_WINDOWS } from "../../src/route-limits.ts";
import { FailureReasonsArtifactSchema } from "../routes/failure-reasons.ts";

export const GetFailureReasonsInputSchema = z
  .object({
    window: z
      .enum(FAILURE_REASONS_WINDOWS as [string, ...string[]])
      .optional()
      .describe(
        "Trailing time window to aggregate over, ending at the latest data point rather than a calendar boundary. Options are per-tool; see this parameter's enum.",
      )
      .meta({ examples: [FAILURE_REASONS_WINDOWS[0]] }),
    netuid: netuidSchema().optional(),
    kind: kindStringSchema().optional(),
  })
  .strict();
export type GetFailureReasonsInput = z.infer<
  typeof GetFailureReasonsInputSchema
>;

export const GetFailureReasonsOutputSchema = FailureReasonsArtifactSchema;
export type GetFailureReasonsOutput = z.infer<
  typeof GetFailureReasonsOutputSchema
>;
