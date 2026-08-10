// GET /api/v1/health/failure-reasons (#9622): why surfaces fail, and whether
// the mix is changing. Modeled from src/failure-reasons.ts's
// buildFailureReasons().
import { z } from "zod";
import { UnavailableDegradedSchema } from "./event-stream-honesty.ts";

export const FailureReasonSchema = z
  .object({
    classification: z.string(),
    /** `redirected` is NOT a failure -- a surface answering from a new location
     * is serving, and the probe's own status says so. */
    is_failure: z
      .boolean()
      .describe(
        "redirected is NOT a failure -- a surface answering from a new location is serving.",
      ),
    checks: z.int().min(0),
    /** Of every probe in the window. */
    share: z
      .number()
      .min(0)
      .max(1)
      .nullable()
      .describe("Of every probe in the window."),
    /** Of the FAILING probes only; null on a succeeding classification, where
     * the question does not apply. */
    failure_share: z
      .number()
      .min(0)
      .max(1)
      .nullable()
      .describe(
        "Of the FAILING probes only; null on a succeeding classification, where the question does not apply.",
      ),
  })
  .strict();

export const FailureReasonsDaySchema = z
  .object({
    day: z.string(),
    total_checks: z.int().min(0),
    failing_checks: z.int().min(0),
    failure_rate: z.number().min(0).max(1).nullable(),
    by_classification: z
      .record(z.string(), z.int().min(0))
      .describe("Checks per classification on this day, as a JSON object."),
  })
  .strict();

export const FailureReasonsArtifactSchema = z
  .object({
    schema_version: z.int(),
    window: z.string().nullable(),
    netuid: z.int().min(0).max(65535).nullable(),
    kind: z.string().nullable(),
    /** Counted from the ROWS, not the requested window -- a day the prober did
     * not run is absent rather than a zero. */
    days_covered: z
      .int()
      .min(0)
      .nullable()
      .describe(
        "Counted from the ROWS, not the requested window -- a day the prober did not run is absent rather than a zero.",
      ),
    oldest_day: z.string().nullable(),
    newest_day: z.string().nullable(),
    total_checks: z.int().min(0).nullable(),
    failing_checks: z.int().min(0).nullable(),
    failure_rate: z.number().min(0).max(1).nullable(),
    reasons: z.array(FailureReasonSchema),
    /** Oldest day first, so a caller plotting the series need not reverse it. */
    series: z.array(FailureReasonsDaySchema).describe("Oldest day first."),
    /** Present ONLY on a decline. An empty window is NOT a decline: it means
     * the prober recorded nothing in that range, which is a measurement. */
    degraded: UnavailableDegradedSchema.optional().describe(
      "Present ONLY on a decline. An empty window is a measurement, not a decline.",
    ),
  })
  .passthrough();
export type FailureReasonsArtifact = z.infer<
  typeof FailureReasonsArtifactSchema
>;
