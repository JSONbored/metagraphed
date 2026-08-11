// GET /api/v1/subnets/{netuid}/trajectory (types-epic B batch 2, #8056).
// Live subnet_snapshots-tier daily sparkline + windowed deltas -- no static
// file. Modeled from the formatTrajectory() shape (workers/request-handlers/
// analytics-routes.ts), cross-checked against the hand-edited
// SubnetTrajectoryArtifact component it replaces. No query params -- unlike
// the sibling history routes, trajectory takes no ?window (the full points
// series plus precomputed 7d/30d deltas cover that).
import { z } from "zod";

/** One window's change, endpoint to endpoint. Every field is a DIFFERENCE
 * (`to` minus `from`), not a level -- a negative `tao_in_pool_tao` means the
 * pool shrank over the window, and the two dates say which two observations
 * were subtracted. */
export const SubnetTrajectoryDeltaSchema = z
  .object({
    from_date: z.string(),
    to_date: z.string(),
    // `z.int()`, matching the POINT schema above rather than the `z.number()`
    // this used to declare (#10404). The two describe the same three fields --
    // a point's value and a difference of two of them -- and `src/health-
    // serving.ts` runs every point through `roundInt()` before `diff()`
    // subtracts a pair, so a fractional delta is unreachable. GraphQL had it
    // right (`Int`) and the component disagreed; nothing compared them while
    // the type sat in RESOLVER_BUILT_TYPES.
    completeness_score: z.int().nullable().optional(),
    surface_count: z.int().nullable().optional(),
    endpoint_count: z.int().nullable().optional(),
    tao_in_pool_tao: z.number().nullable().optional(),
    alpha_in_pool: z.number().nullable().optional(),
    alpha_out_pool: z.number().nullable().optional(),
  })
  .strict();

const SubnetTrajectoryPointSchema = z
  .object({
    date: z.string(),
    completeness_score: z.int().nullable().optional(),
    surface_count: z.int().nullable().optional(),
    endpoint_count: z.int().nullable().optional(),
    validator_count: z.int().nullable().optional(),
    miner_count: z.int().nullable().optional(),
    total_stake_alpha: z.number().nullable().optional(),
    alpha_price_tao: z.number().nullable().optional(),
    emission_share: z.number().nullable().optional(),
    tao_in_pool_tao: z.number().nullable().optional(),
    alpha_in_pool: z.number().nullable().optional(),
    alpha_out_pool: z.number().nullable().optional(),
    subnet_volume_tao: z.number().nullable().optional(),
  })
  .strict()
  .describe(
    "One daily-snapshot point on a subnet's trajectory (chronological). Economics fields are null on rows captured before those columns existed / when economics was unavailable that day.",
  );

export const SubnetTrajectoryArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    point_count: z.int().min(0),
    points: z.array(SubnetTrajectoryPointSchema),
    // Keyed by window label ("7d"/"30d") -- a typed record, so a new window
    // adds a key rather than changing the contract. The VALUE was the untyped
    // half of it (#9800): the hand-written original declared
    // `{type:["object","null"], additionalProperties:true}` and stopped
    // there, so the deltas this route exists to serve had no declared shape
    // at all. Modeled from formatTrajectory() and verified against the live
    // response for both windows.
    deltas: z
      .record(z.string(), SubnetTrajectoryDeltaSchema.nullable())
      .describe(
        "Latest-vs-window-ago deltas -- one entry per window (7d, 30d) that has a prior point to compare against; empty when the series is too short.",
      ),
  })
  .strict()
  .describe(
    "One subnet's weekly structural + economics trajectory from the daily snapshots (#5887). Mirrors GET /api/v1/subnets/{netuid}/trajectory's data envelope. The REST envelope's window-keyed deltas map (7d/30d) is exposed here as a list carrying each window label, since those keys are not valid GraphQL field names.",
  );
export type SubnetTrajectoryArtifact = z.infer<
  typeof SubnetTrajectoryArtifactSchema
>;
