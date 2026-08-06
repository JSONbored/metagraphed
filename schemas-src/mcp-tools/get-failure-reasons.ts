// get_failure_reasons (#9622): why surfaces fail and whether the mix is
// changing, mirroring GET /api/v1/health/failure-reasons.
import { z } from "zod";
import { kindStringSchema, netuidSchema } from "./shared.ts";
import { FAILURE_REASONS_WINDOWS } from "../../src/route-limits.ts";

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

export const GetFailureReasonsOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    window: z.string().nullable(),
    netuid: netuidSchema().nullable(),
    kind: z.string().nullable(),
    days_covered: z.int().nullable(),
    oldest_day: z.string().nullable(),
    newest_day: z.string().nullable(),
    total_checks: z.int().nullable(),
    failing_checks: z.int().nullable(),
    failure_rate: z.number().nullable(),
    reasons: z.array(
      z
        .object({
          classification: z.string(),
          is_failure: z.boolean(),
          checks: z.int(),
          share: z.number().nullable(),
          failure_share: z.number().nullable(),
        })
        .passthrough(),
    ),
    series: z.array(
      z
        .object({
          day: z.string(),
          total_checks: z.int(),
          failing_checks: z.int(),
          failure_rate: z.number().nullable(),
          by_classification: z.record(z.string(), z.int()),
        })
        .passthrough(),
    ),
    // Present ONLY on a decline. An empty window is a MEASUREMENT -- the prober
    // recorded nothing in that range -- so a model must read this before
    // concluding the read failed.
    degraded: z
      .object({ reason: z.enum(["unavailable"]) })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type GetFailureReasonsOutput = z.infer<
  typeof GetFailureReasonsOutputSchema
>;
