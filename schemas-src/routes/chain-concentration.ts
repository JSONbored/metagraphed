// GET /api/v1/chain/concentration (types-epic B batch 6, #8060). Live
// neurons D1-tier data -- no static file. Modeled from src/concentration.ts's
// buildChainConcentration() (which reuses computeConcentration(), the exact
// function ConcentrationMetricsSchema in shared.ts models, from types-epic B
// batch 3/#8057), cross-checked against the hand-edited
// ChainConcentrationArtifact component it replaces.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";
import { ConcentrationMetricsSchema } from "../shared.ts";

export const ChainConcentrationArtifactSchema = z
  .object({
    schema_version: z.int(),
    subnet_count: z.int().min(0),
    neuron_count: z.int().min(0),
    entity_count: z.int().min(0),
    uids_per_entity: z.number().nullable(),
    captured_at: z.string().nullable(),
    stake: ConcentrationMetricsSchema,
    emission: ConcentrationMetricsSchema,
    entity_stake: ConcentrationMetricsSchema,
    entity_emission: ConcentrationMetricsSchema,
    validator_stake: ConcentrationMetricsSchema,
  })
  .passthrough();
export type ChainConcentrationArtifact = z.infer<
  typeof ChainConcentrationArtifactSchema
>;
export const ChainConcentrationResponseSchema = successEnvelopeSchema(
  ChainConcentrationArtifactSchema,
);
export const ChainConcentrationQuerySchema = z.object({}).strict();
export type ChainConcentrationQuery = z.infer<
  typeof ChainConcentrationQuerySchema
>;
