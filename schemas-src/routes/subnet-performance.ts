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

/** This route's own vocabulary, owned here so its MCP tool imports rather than restates it (#9799). */
export const SUBNET_PERFORMANCE_WINDOW_VALUES = ["7d", "30d", "90d"] as const;

export const SubnetPerformanceArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    neuron_count: z.int().min(0),
    validator_count: z.int().min(0).optional(),
    active_count: z.int().min(0).optional(),
    captured_at: z.string().nullable().optional(),
    incentive: ConcentrationMetricsSchema.describe(
      "Incentive concentration across all neurons with positive incentive.",
    ),
    dividends: ConcentrationMetricsSchema.describe(
      "Dividends concentration across permitted validators only.",
    ),
    trust: ScoreDistributionSchema.describe(
      "Trust score spread across all neurons.",
    ),
    consensus: ScoreDistributionSchema.describe(
      "Consensus score spread across all neurons.",
    ),
    validator_trust: ScoreDistributionSchema.optional().describe(
      "Validator-trust score spread across permitted validators only.",
    ),
  })
  .passthrough()
  .describe(
    "Per-subnet reward-distribution & score-spread card (#5714). Metric blocks are null on a cold/empty subnet. Mirrors GET /api/v1/subnets/{netuid}/performance.",
  );
export type SubnetPerformanceArtifact = z.infer<
  typeof SubnetPerformanceArtifactSchema
>;
export const SubnetPerformanceResponseSchema = successEnvelopeSchema(
  SubnetPerformanceArtifactSchema,
);

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
  .passthrough()
  .describe(
    "One day's point in a subnet's concentration trend (#5901). Flattened (not nested) stake/emission metrics keep the series trivial to plot; each is null on a cold/empty day.",
  );

export const SubnetPerformanceHistoryArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    window: z
      .string()
      .nullable()
      .optional()
      .describe("The resolved window label (7d/30d/90d)."),
    point_count: z.int().min(0),
    points: z.array(SubnetPerformanceHistoryPointSchema),
  })
  .passthrough()
  .describe(
    "Per-subnet per-day reward-distribution trend (#6981) from the neuron_daily rollup, newest first. An empty series (point_count 0) on a cold store, never a GraphQL error. The history twin of subnet_performance, mirroring GET /api/v1/subnets/{netuid}/performance/history.",
  );
export type SubnetPerformanceHistoryArtifact = z.infer<
  typeof SubnetPerformanceHistoryArtifactSchema
>;
export const SubnetPerformanceHistoryResponseSchema = successEnvelopeSchema(
  SubnetPerformanceHistoryArtifactSchema,
);
