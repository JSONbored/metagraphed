// GET /api/v1/chain/turnover (types-epic B batch 6, #8060). Live
// neuron_daily D1-tier data -- no static file. Modeled from
// src/chain-turnover.ts's buildChainTurnover(), cross-checked against the
// hand-edited ChainTurnoverArtifact component it replaces.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";

const StabilityDistributionSchema = z
  .object({
    count: z.int().min(0),
    mean: z.number().min(0).max(100),
    min: z.int().min(0).max(100),
    p25: z.int().min(0).max(100),
    median: z.number().min(0).max(100),
    p75: z.int().min(0).max(100),
    p90: z.int().min(0).max(100),
    max: z.int().min(0).max(100),
  })
  .strict();

export const ChainTurnoverArtifactSchema = z
  .object({
    schema_version: z.int(),
    window: z.enum(["7d", "30d", "90d"]).nullable(),
    start_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    end_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    comparable: z.boolean(),
    subnet_count: z.int().min(0),
    network: z
      .object({
        validators_start: z.int().min(0),
        validators_end: z.int().min(0),
        validators_entered: z.int().min(0),
        validators_exited: z.int().min(0),
        validator_retention: z.number().min(0).max(1).nullable(),
        stability_score: z.int().min(0).max(100).nullable(),
      })
      .strict(),
    stability_distribution: StabilityDistributionSchema.nullable(),
    subnets: z.array(
      z
        .object({
          netuid: z.int().min(0),
          validators_start: z.int().min(0),
          validators_end: z.int().min(0),
          validators_entered: z.int().min(0),
          validators_exited: z.int().min(0),
          validator_retention: z.number().min(0).max(1).nullable(),
          stability_score: z.int().min(0).max(100).nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type ChainTurnoverArtifact = z.infer<typeof ChainTurnoverArtifactSchema>;
export const ChainTurnoverResponseSchema = successEnvelopeSchema(
  ChainTurnoverArtifactSchema,
);
export const ChainTurnoverQuerySchema = z
  .object({
    window: z.enum(["7d", "30d", "90d"]).optional(),
    limit: z.int().min(1).optional(),
    format: z.enum(["json", "csv"]).optional(),
  })
  .strict();
export type ChainTurnoverQuery = z.infer<typeof ChainTurnoverQuerySchema>;
