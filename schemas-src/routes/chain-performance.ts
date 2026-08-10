// GET /api/v1/chain/performance (types-epic B batch 6, #8060). Live neurons
// D1-tier data -- no static file. Modeled from src/chain-performance.ts's
// buildChainPerformance() (which reuses computeConcentration()/
// scoreDistribution(), the exact functions ConcentrationMetricsSchema/
// ScoreDistributionSchema in shared.ts model, from types-epic B batch
// 3/#8057 -- the network-wide twin of batch 3's own SubnetPerformanceArtifact),
// cross-checked against the hand-edited ChainPerformanceArtifact component
// it replaces.
import { z } from "zod";
import {
  ConcentrationMetricsSchema,
  ScoreDistributionSchema,
} from "../shared.ts";

export const ChainPerformanceArtifactSchema = z
  .object({
    schema_version: z.int(),
    subnet_count: z
      .int()
      .min(0)
      .describe("Distinct subnets the snapshot spans."),
    neuron_count: z.int().min(0),
    validator_count: z.int().min(0).optional(),
    active_count: z.int().min(0).optional(),
    captured_at: z.string().nullable().optional(),
    incentive: ConcentrationMetricsSchema.describe(
      "Incentive concentration across all neurons network-wide with positive incentive.",
    ),
    dividends: ConcentrationMetricsSchema.describe(
      "Dividends concentration across permitted validators network-wide only.",
    ),
    trust: ScoreDistributionSchema.describe(
      "Trust score spread across all neurons network-wide.",
    ),
    consensus: ScoreDistributionSchema.describe(
      "Consensus score spread across all neurons network-wide.",
    ),
    validator_trust: ScoreDistributionSchema.optional().describe(
      "Validator-trust score spread across permitted validators network-wide only.",
    ),
  })
  .passthrough()
  .describe(
    "Network-wide reward-distribution & score-spread card (#5688) -- the network analog of SubnetPerformance, spanning every subnet's neurons in one snapshot. Metric blocks are null on a cold/empty store. Mirrors GET /api/v1/chain/performance.",
  );
export type ChainPerformanceArtifact = z.infer<
  typeof ChainPerformanceArtifactSchema
>;
