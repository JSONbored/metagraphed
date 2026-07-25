// GET /api/v1/chain/alpha-volume (types-epic B batch 6, #8060). Live
// account_events StakeAdded/StakeRemoved-stream data -- no static file.
// Modeled from src/chain-alpha-volume.ts's buildChainAlphaVolume() (which
// reuses src/alpha-volume.ts's buildAlphaVolume() per-subnet scorecard,
// the SAME function types-epic B batch 1's subnet-alpha-volume.ts already
// modeled), cross-checked against the hand-edited ChainAlphaVolumeArtifact
// component it replaces.
//
// `subnets[]` reuses SubnetAlphaVolumeArtifactSchema from batch 1 (#8055)
// directly, per the hand-edited component's own description: "each with the
// same buy/sell/total volume + sentiment scorecard SubnetAlphaVolumeArtifact
// carries". VolumeDistribution is intentionally NOT registered as a shared
// component -- ChainAlphaVolumeArtifact is its only referrer (verified via
// repo-wide $ref grep), so the hand-edited component key becomes fully
// orphaned.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";
import { SubnetAlphaVolumeArtifactSchema } from "./subnet-alpha-volume.ts";

const VolumeDistributionSchema = z
  .object({
    count: z.int().min(0),
    mean: z.number().min(0),
    min: z.number().min(0),
    p25: z.number().min(0),
    median: z.number().min(0),
    p75: z.number().min(0),
    p90: z.number().min(0),
    max: z.number().min(0),
  })
  .strict();

export const ChainAlphaVolumeArtifactSchema = z
  .object({
    schema_version: z.int(),
    window: z.enum(["24h"]),
    observed_at: z.string().nullable(),
    subnet_count: z.int().min(0),
    network: z
      .object({
        buy_volume_alpha: z.number().min(0),
        sell_volume_alpha: z.number().min(0),
        total_volume_alpha: z.number().min(0),
        buy_volume_tao: z.number().min(0),
        sell_volume_tao: z.number().min(0),
        total_volume_tao: z.number().min(0),
        buy_count: z.int().min(0),
        sell_count: z.int().min(0),
        net_volume_alpha: z.number(),
        sentiment_ratio: z.number().nullable(),
        sentiment: z.enum(["bullish", "bearish", "neutral"]),
      })
      .strict(),
    volume_distribution: VolumeDistributionSchema.nullable(),
    subnets: z.array(SubnetAlphaVolumeArtifactSchema),
  })
  .strict();
export type ChainAlphaVolumeArtifact = z.infer<
  typeof ChainAlphaVolumeArtifactSchema
>;
export const ChainAlphaVolumeResponseSchema = successEnvelopeSchema(
  ChainAlphaVolumeArtifactSchema,
);
export const ChainAlphaVolumeQuerySchema = z
  .object({
    limit: z.int().min(1).optional(),
    format: z.enum(["json", "csv"]).optional(),
  })
  .strict();
export type ChainAlphaVolumeQuery = z.infer<typeof ChainAlphaVolumeQuerySchema>;
