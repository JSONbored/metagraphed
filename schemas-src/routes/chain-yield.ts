// GET /api/v1/chain/yield (types-epic B batch 6, #8060). Live neurons
// D1-tier data -- no static file. Modeled from src/chain-yield.ts's
// buildChainYield()/yieldDistribution(), cross-checked against the
// hand-edited ChainYieldArtifact component it replaces.
//
// YieldDistribution is intentionally NOT registered as a shared component --
// ChainYieldArtifact is its only referrer (verified via repo-wide $ref
// grep), so the hand-edited component key becomes fully orphaned.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";

const YieldDistributionSchema = z
  .object({
    count: z.int().min(0),
    mean: z.number(),
    median: z.number(),
    min: z.number(),
    max: z.number(),
    p10: z.number(),
    p25: z.number(),
    p75: z.number(),
    p90: z.number(),
  })
  .passthrough()
  .nullable();

export const ChainYieldArtifactSchema = z
  .object({
    schema_version: z.int(),
    subnet_count: z.int().min(0),
    neuron_count: z.int().min(0),
    validator_count: z.int().min(0).optional(),
    miner_count: z.int().min(0).optional(),
    captured_at: z.string().nullable().optional(),
    total_stake_tao: z.number().optional(),
    total_emission_tao: z.number().optional(),
    network_yield: z.number().nullable(),
    validator_yield: z.number().nullable().optional(),
    miner_yield: z.number().nullable().optional(),
    distribution: YieldDistributionSchema,
  })
  .passthrough();
export type ChainYieldArtifact = z.infer<typeof ChainYieldArtifactSchema>;
export const ChainYieldResponseSchema = successEnvelopeSchema(
  ChainYieldArtifactSchema,
);
export const ChainYieldQuerySchema = z.object({}).strict();
export type ChainYieldQuery = z.infer<typeof ChainYieldQuerySchema>;
