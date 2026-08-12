// GET /api/v1/chain/performance (types-epic B batch 6, #8060). Live neurons
// store-tier data -- no static file. Modeled from src/chain-performance.ts's
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
    // NULLABLE for the reason the sibling subnet card records (#10786): the
    // PRODUCERS answer null. `computeConcentration` returns
    // `ConcentrationScorecard | null` when no value in the population is
    // positive, and `scoreDistribution` returns `ScoreDistribution | null` when
    // no cell is finite -- src/subnet-performance.ts states it at the top of
    // the file, "an empty / all-zero distribution yields a schema-stable null
    // block". The network-wide card runs the same two functions over the same
    // shape, so it has the same answer on a cold store.
    incentive: ConcentrationMetricsSchema.nullable().describe(
      "Incentive concentration across all neurons network-wide with positive incentive.",
    ),
    dividends: ConcentrationMetricsSchema.nullable().describe(
      "Dividends concentration across permitted validators network-wide only.",
    ),
    trust: ScoreDistributionSchema.nullable().describe(
      "Trust score spread across all neurons network-wide.",
    ),
    consensus: ScoreDistributionSchema.nullable().describe(
      "Consensus score spread across all neurons network-wide.",
    ),
    validator_trust: ScoreDistributionSchema.nullable()
      .optional()
      .describe(
        "Validator-trust score spread across permitted validators network-wide only.",
      ),
  })
  .strict()
  .describe(
    "Network-wide reward-distribution & score-spread card (#5688) -- the network analog of SubnetPerformance, spanning every subnet's neurons in one snapshot. Metric blocks are null on a cold/empty store. Mirrors GET /api/v1/chain/performance.",
  );
export type ChainPerformanceArtifact = z.infer<
  typeof ChainPerformanceArtifactSchema
>;
