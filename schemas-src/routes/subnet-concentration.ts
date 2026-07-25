// GET /api/v1/subnets/{netuid}/concentration + .../concentration/history
// (types-epic B batch 2, #8056). Live neurons/neuron_daily-tier stats -- no
// static file. Modeled from src/concentration.ts's buildConcentration()/
// buildConcentrationHistory(), cross-checked against the hand-edited
// SubnetConcentrationArtifact/SubnetConcentrationHistoryArtifact components
// they replace. The inline stake/emission/entity_stake/entity_emission/
// validator_stake lens shape is intentionally NOT the shared
// ConcentrationMetrics component (schemas/components/06-health.schema.json)
// -- the hand-written SubnetConcentrationArtifact never $ref'd it either
// (kept independently inline), and ConcentrationMetrics is still referenced
// by SubnetPerformanceArtifact (a different, not-yet-converted route) --
// touching it is out of this batch's scope.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";

const ConcentrationLensSchema = z
  .object({
    holders: z.int().min(0).optional(),
    total: z.number().nullable().optional(),
    gini: z.number().nullable().optional(),
    hhi: z.number().nullable().optional(),
    hhi_normalized: z.number().nullable().optional(),
    nakamoto_coefficient: z.int().nullable().optional(),
    top_1pct_share: z.number().nullable().optional(),
    top_5pct_share: z.number().nullable().optional(),
    top_10pct_share: z.number().nullable().optional(),
    top_20pct_share: z.number().nullable().optional(),
    entropy: z.number().nullable().optional(),
    entropy_normalized: z.number().nullable().optional(),
  })
  .passthrough();

export const SubnetConcentrationArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    neuron_count: z.int().min(0),
    entity_count: z.int().min(0),
    uids_per_entity: z.number().nullable().optional(),
    captured_at: z.string().nullable().optional(),
    stake: ConcentrationLensSchema.nullable(),
    emission: ConcentrationLensSchema.nullable(),
    entity_stake: ConcentrationLensSchema.nullable().optional(),
    entity_emission: ConcentrationLensSchema.nullable().optional(),
    validator_stake: ConcentrationLensSchema.nullable().optional(),
  })
  .passthrough();
export type SubnetConcentrationArtifact = z.infer<
  typeof SubnetConcentrationArtifactSchema
>;
export const SubnetConcentrationResponseSchema = successEnvelopeSchema(
  SubnetConcentrationArtifactSchema,
);
export const SubnetConcentrationQuerySchema = z.object({}).strict();
export type SubnetConcentrationQuery = z.infer<
  typeof SubnetConcentrationQuerySchema
>;

const SubnetConcentrationHistoryPointSchema = z
  .object({
    snapshot_date: z.string(),
    neuron_count: z.int().min(0).optional(),
    stake_gini: z.number().nullable().optional(),
    stake_nakamoto_coefficient: z.int().nullable().optional(),
    stake_top_10pct_share: z.number().nullable().optional(),
    emission_gini: z.number().nullable().optional(),
    emission_nakamoto_coefficient: z.int().nullable().optional(),
    emission_top_10pct_share: z.number().nullable().optional(),
  })
  .passthrough();

export const SubnetConcentrationHistoryArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    window: z.string().nullable().optional(),
    point_count: z.int().min(0),
    points: z.array(SubnetConcentrationHistoryPointSchema),
  })
  .passthrough();
export type SubnetConcentrationHistoryArtifact = z.infer<
  typeof SubnetConcentrationHistoryArtifactSchema
>;
export const SubnetConcentrationHistoryResponseSchema = successEnvelopeSchema(
  SubnetConcentrationHistoryArtifactSchema,
);
export const SubnetConcentrationHistoryQuerySchema = z
  .object({
    window: z.enum(["7d", "30d", "90d"]).optional(),
  })
  .strict();
export type SubnetConcentrationHistoryQuery = z.infer<
  typeof SubnetConcentrationHistoryQuerySchema
>;
