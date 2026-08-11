// GET /api/v1/subnets/{netuid}/history (types-epic B batch 1, #8055). Live
// neuron_daily-tier daily sparkline -- no static file. Modeled from
// src/neuron-history.ts's buildSubnetHistory(), cross-checked against the
// hand-edited SubnetHistoryArtifact component it replaces. `window` stays
// a bare nullable string (no enum) matching the original exactly: although
// parseHistoryWindow() always resolves a concrete label from
// HISTORY_WINDOW_DAYS ("7d"/"30d"/"90d"/"1y"/"all") before this is built, adding
// an enum here would be a real (if inert) tightening the issue's wire-
// compatibility constraint doesn't require -- left loose on purpose.
import { z } from "zod";

/** This route's own vocabulary, owned here so its MCP tool imports rather than restates it (#9799). */
export const SUBNET_HISTORY_WINDOW_VALUES = [
  "7d",
  "30d",
  "90d",
  "1y",
  "all",
] as const;

const SubnetHistoryPointSchema = z
  .object({
    snapshot_date: z.string(),
    neuron_count: z.int().nullable().optional(),
    validator_count: z.int().nullable().optional(),
    total_stake_alpha: z.number().nullable().optional(),
    total_emission_alpha: z.number().nullable().optional(),
  })
  .strict()
  .describe(
    "One daily-rollup point on a subnet's history (#7172). Economics fields are null on days captured before those columns existed / when unavailable.",
  );

export const SubnetHistoryArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    window: z.string().nullable().optional(),
    point_count: z.int().min(0),
    /**
     * WHAT THE RESPONSE ACTUALLY COVERED, beside what was asked for (#10788).
     *
     * `window` echoes the REQUEST -- ask for `1y` and this says `1y` -- so
     * without these a consumer receiving 33 points could not tell "that is all
     * that happened" from "that is all we hold". Same reasoning, and the same
     * shape, as /health/failure-reasons: depth counted from the ROWS rather
     * than the requested window.
     *
     * `days_covered` counts DISTINCT days present rather than the span, so a
     * gap in the middle is visible instead of implied away by oldest/newest.
     */
    oldest_day: z.string().nullable(),
    newest_day: z.string().nullable(),
    days_covered: z.int().min(0),
    points: z.array(SubnetHistoryPointSchema),
  })
  .passthrough()
  .describe(
    "One subnet's daily history series (#7172) from the neuron_daily rollup, newest first. Empty series (point_count 0) on a cold/absent store. Mirrors GET /api/v1/subnets/{netuid}/history' data envelope.",
  );
export type SubnetHistoryArtifact = z.infer<typeof SubnetHistoryArtifactSchema>;
