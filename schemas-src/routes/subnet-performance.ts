// GET /api/v1/subnets/{netuid}/performance + .../performance/history
// (types-epic B batch 3, #8057). Live neurons/neuron_daily-tier data -- no
// static file. Modeled from src/subnet-performance.ts's buildSubnetPerformance()
// / buildSubnetPerformanceHistory() (which reuse src/concentration.ts's
// computeConcentration() and this same file's scoreDistribution() -- the exact
// functions ConcentrationMetricsSchema/ScoreDistributionSchema in shared.ts
// model), cross-checked against the hand-edited SubnetPerformanceArtifact/
// SubnetPerformanceHistoryArtifact components they replace, and against a live
// get_subnet_performance/get_subnet_performance_history response for subnet 1.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";
import {
  ConcentrationMetricsSchema,
  ScoreDistributionSchema,
} from "../shared.ts";

export const SubnetPerformanceArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
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
export type SubnetPerformanceArtifact = z.infer<
  typeof SubnetPerformanceArtifactSchema
>;
export const SubnetPerformanceResponseSchema = successEnvelopeSchema(
  SubnetPerformanceArtifactSchema,
);
export const SubnetPerformanceQuerySchema = z.object({}).strict();
export type SubnetPerformanceQuery = z.infer<
  typeof SubnetPerformanceQuerySchema
>;

const SubnetPerformanceHistoryPointSchema = z
  .object({
    snapshot_date: z.string(),
    neuron_count: z.int().min(0).optional(),
    validator_count: z.int().min(0).optional(),
    active_count: z.int().min(0).optional(),
    incentive_gini: z.number().nullable().optional(),
    incentive_nakamoto_coefficient: z.int().nullable().optional(),
    incentive_top_10pct_share: z.number().nullable().optional(),
    dividends_gini: z.number().nullable().optional(),
    dividends_nakamoto_coefficient: z.int().nullable().optional(),
    dividends_top_10pct_share: z.number().nullable().optional(),
    trust_mean: z.number().nullable().optional(),
    trust_median: z.number().nullable().optional(),
    consensus_mean: z.number().nullable().optional(),
    consensus_median: z.number().nullable().optional(),
    validator_trust_mean: z.number().nullable().optional(),
    validator_trust_median: z.number().nullable().optional(),
  })
  .passthrough();

export const SubnetPerformanceHistoryArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    window: z.string().nullable().optional(),
    point_count: z.int().min(0),
    points: z.array(SubnetPerformanceHistoryPointSchema),
  })
  .passthrough();
export type SubnetPerformanceHistoryArtifact = z.infer<
  typeof SubnetPerformanceHistoryArtifactSchema
>;
export const SubnetPerformanceHistoryResponseSchema = successEnvelopeSchema(
  SubnetPerformanceHistoryArtifactSchema,
);
export const SubnetPerformanceHistoryQuerySchema = z
  .object({
    window: z.enum(["7d", "30d", "90d"]).optional(),
    format: z.enum(["json", "csv"]).optional(),
  })
  .strict();
export type SubnetPerformanceHistoryQuery = z.infer<
  typeof SubnetPerformanceHistoryQuerySchema
>;
