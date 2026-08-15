// The envelope every ONE-SUBNET DAILY SERIES answers in.
//
// Two routes share it exactly -- `/subnets/{netuid}/emission-pipeline/history`
// (#9625) and `/subnets/{netuid}/deregistration-ranking/history` (#10296) --
// and they share it because the honesty contract is the same contract, not
// because the fields happened to line up:
//
//   point_count            rows returned
//   distinct_observations  how many of those are INDEPENDENT observations, and
//                          the only honest denominator for a claim that
//                          anything MOVED. A daily writer that carries the last
//                          capture forward makes two consecutive points the
//                          same reading, and treating that as flatness is a
//                          finding the data does not support.
//   oldest_day/newest_day  the depth FOUND, never the window requested
//   first_captured_day     where the series begins, on every response, so a
//                          short answer reads as a start rather than as
//                          dropped days
//   degraded               present ONLY on a decline -- an empty series is a
//                          measurement
//
// DECLARED ONCE because a second copy drifts, and the drift is silent in the
// dangerous direction: the narrower side keeps accepting what it no longer
// describes. `validate:schema-shape-duplicates` is what caught the copy.
//
// The DESCRIPTIONS stay per-route. The shape is shared; what `point_count`
// counts on a given surface is that surface's own sentence, and collapsing
// those into one generic line would make both worse.
import { z } from "zod";
import { UnavailableDegradedSchema } from "./event-stream-honesty.ts";

export interface DailySubnetSeriesText {
  /** What a row IS on this surface, and what it is not. */
  pointCount: string;
  /** What makes an observation independent here. */
  distinctObservations: string;
  /** Where this series begins and why that is published. */
  firstCapturedDay: string;
  /** What an empty series means on this surface. */
  degraded: string;
}

/**
 * The artifact schema for one subnet's daily series over `point`.
 *
 * `point` is the only thing that differs, so it is the only parameter: each
 * caller registers its own point component and gets the same envelope around
 * it, and a field added here reaches both surfaces at once.
 */
export function dailySubnetSeriesArtifact<Point extends z.ZodTypeAny>(
  point: Point,
  text: DailySubnetSeriesText,
) {
  return z
    .object({
      schema_version: z.int(),
      netuid: z.int().min(0).max(65535),
      window: z.string().nullable(),
      point_count: z.int().min(0).nullable().describe(text.pointCount),
      distinct_observations: z
        .int()
        .min(0)
        .nullable()
        .describe(text.distinctObservations),
      oldest_day: z.string().nullable(),
      newest_day: z.string().nullable(),
      first_captured_day: z.string().describe(text.firstCapturedDay),
      points: z.array(point),
      degraded: UnavailableDegradedSchema.optional().describe(text.degraded),
    })
    .strict();
}
