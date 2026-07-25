// GET /api/v1/validators/{hotkey}/history (types-epic B batch 7, #8061).
// Live neuron_daily D1-tier data -- no static file. Modeled from
// src/validator-history.ts's buildValidatorHistory(), cross-checked against
// the hand-edited ValidatorHistoryArtifact component it replaces.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";

const ValidatorHistoryPointSchema = z
  .object({
    snapshot_date: z.string(),
    subnet_count: z.int().min(0).nullable(),
    total_stake_tao: z.number().nullable(),
    total_emission_tao: z.number().nullable(),
    rewards_per_1000_tao: z.number().nullable(),
  })
  .strict();

export const ValidatorHistoryArtifactSchema = z
  .object({
    schema_version: z.int(),
    hotkey: z.string(),
    window: z.string().nullable(),
    point_count: z.int().min(0),
    points: z.array(ValidatorHistoryPointSchema),
  })
  .passthrough();
export type ValidatorHistoryArtifact = z.infer<
  typeof ValidatorHistoryArtifactSchema
>;
export const ValidatorHistoryResponseSchema = successEnvelopeSchema(
  ValidatorHistoryArtifactSchema,
);
export const ValidatorHistoryQuerySchema = z
  .object({
    window: z.enum(["7d", "30d", "90d", "1y", "all"]).optional(),
  })
  .strict();
export type ValidatorHistoryQuery = z.infer<typeof ValidatorHistoryQuerySchema>;
