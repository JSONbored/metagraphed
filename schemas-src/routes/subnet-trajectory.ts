// GET /api/v1/subnets/{netuid}/trajectory (types-epic B batch 2, #8056).
// Live subnet_snapshots-tier daily sparkline + windowed deltas -- no static
// file. Modeled from the formatTrajectory() shape (workers/request-handlers/
// analytics-routes.ts), cross-checked against the hand-edited
// SubnetTrajectoryArtifact component it replaces. No query params -- unlike
// the sibling history routes, trajectory takes no ?window (the full points
// series plus precomputed 7d/30d deltas cover that).
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";

const SubnetTrajectoryPointSchema = z
  .object({
    date: z.string(),
    completeness_score: z.int().nullable().optional(),
    surface_count: z.int().nullable().optional(),
    endpoint_count: z.int().nullable().optional(),
    validator_count: z.int().nullable().optional(),
    miner_count: z.int().nullable().optional(),
    total_stake_tao: z.number().nullable().optional(),
    alpha_price_tao: z.number().nullable().optional(),
    emission_share: z.number().nullable().optional(),
    tao_in_pool_tao: z.number().nullable().optional(),
    alpha_in_pool: z.number().nullable().optional(),
    alpha_out_pool: z.number().nullable().optional(),
    subnet_volume_tao: z.number().nullable().optional(),
  })
  .passthrough();

export const SubnetTrajectoryArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    point_count: z.int().min(0),
    points: z.array(SubnetTrajectoryPointSchema),
    // Windowed deltas keyed by window label (e.g. "7d"/"30d") -- each value
    // is an open object or null, matching the hand-written original's own
    // `additionalProperties: {type:["object","null"], additionalProperties:true}`
    // map shape (no fixed key set, no per-window field shape declared).
    deltas: z.record(z.string(), z.object({}).passthrough().nullable()),
  })
  .passthrough();
export type SubnetTrajectoryArtifact = z.infer<
  typeof SubnetTrajectoryArtifactSchema
>;
export const SubnetTrajectoryResponseSchema = successEnvelopeSchema(
  SubnetTrajectoryArtifactSchema,
);

export const SubnetTrajectoryQuerySchema = z.object({}).strict();
export type SubnetTrajectoryQuery = z.infer<typeof SubnetTrajectoryQuerySchema>;
