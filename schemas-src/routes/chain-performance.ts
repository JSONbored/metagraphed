// GET /api/v1/chain/performance (types-epic B batch 6, #8060). Live neurons
// D1-tier data -- no static file. Modeled from src/chain-performance.ts's
// buildChainPerformance() (which reuses computeConcentration()/
// scoreDistribution(), the exact functions ConcentrationMetricsSchema/
// ScoreDistributionSchema in shared.ts model, from types-epic B batch
// 3/#8057 -- the network-wide twin of batch 3's own SubnetPerformanceArtifact),
// cross-checked against the hand-edited ChainPerformanceArtifact component
// it replaces.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";
import {
  ConcentrationMetricsSchema,
  ScoreDistributionSchema,
} from "../shared.ts";

export const ChainPerformanceArtifactSchema = z
  .object({
    schema_version: z.int(),
    subnet_count: z.int().min(0),
    neuron_count: z.int().min(0),
    validator_count: z.int().min(0).optional(),
    active_count: z.int().min(0).optional(),
    captured_at: z.string().nullable().optional(),
    incentive: ConcentrationMetricsSchema,
    dividends: ConcentrationMetricsSchema,
    trust: ScoreDistributionSchema,
    consensus: ScoreDistributionSchema,
    validator_trust: ScoreDistributionSchema.optional(),
  })
  .passthrough();
export type ChainPerformanceArtifact = z.infer<
  typeof ChainPerformanceArtifactSchema
>;
export const ChainPerformanceResponseSchema = successEnvelopeSchema(
  ChainPerformanceArtifactSchema,
);
export const ChainPerformanceQuerySchema = z.object({}).strict();
export type ChainPerformanceQuery = z.infer<typeof ChainPerformanceQuerySchema>;
