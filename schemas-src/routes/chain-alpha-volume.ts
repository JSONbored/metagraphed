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
  .strict()
  .describe(
    "Spread of per-subnet total_volume_tao across EVERY subnet with volume (not just the returned page, so the spread stays network-wide when limit truncates the leaderboard).",
  );

export const ChainAlphaVolumeArtifactSchema = z
  .object({
    schema_version: z.int(),
    window: z
      .enum(["24h"])
      .describe("Fixed rolling window label (always 24h)."),
    observed_at: z
      .string()
      .nullable()
      .describe(
        "Newest event observed_at across the window; null on a cold store.",
      ),
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
        sentiment_ratio: z
          .number()
          .nullable()
          .describe(
            "net/gross alpha lean in [-1, 1]; null when there was no volume in the window.",
          ),
        sentiment: z
          .enum(["bullish", "bearish", "neutral"])
          .describe(
            "Coarse sentiment label (bullish/bearish/neutral); neutral both for balanced volume and an empty window.",
          ),
      })
      .strict()
      .describe(
        "Network-wide buy/sell volume rollup across every subnet with volume in the window.",
      ),
    volume_distribution: VolumeDistributionSchema.nullable().describe(
      "Spread of per-subnet total_volume_tao across every subnet with volume; null when no subnet had volume.",
    ),
    subnets: z.array(SubnetAlphaVolumeArtifactSchema),
  })
  .strict()
  .describe(
    "Network-wide rolling 24h buy/sell alpha-volume leaderboard, summed live from the account_events StakeAdded/StakeRemoved stream. Mirrors GET /api/v1/chain/alpha-volume's data envelope.",
  );
export type ChainAlphaVolumeArtifact = z.infer<
  typeof ChainAlphaVolumeArtifactSchema
>;
export const ChainAlphaVolumeResponseSchema = successEnvelopeSchema(
  ChainAlphaVolumeArtifactSchema,
);
