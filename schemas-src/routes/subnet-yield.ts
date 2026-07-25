// GET /api/v1/subnets/{netuid}/yield + .../yield/history (types-epic B
// batch 2, #8056). Live neurons/neuron_daily-tier stats -- no static file.
// Modeled from src/subnet-yield.ts's buildSubnetYield()/
// buildSubnetYieldHistory(), cross-checked against the hand-edited
// SubnetYieldArtifact/SubnetYieldHistoryArtifact components they replace.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";

const SubnetYieldNeuronSchema = z
  .object({
    uid: z.int().min(0),
    hotkey: z.string().nullable(),
    role: z.enum(["validator", "miner"]),
    stake_tao: z.number(),
    emission_tao: z.number().nullable(),
    yield: z.number().nullable(),
    vs_median: z.enum(["above", "below", "at"]).nullable(),
  })
  .strict();

export const SubnetYieldArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    captured_at: z.iso.datetime().nullable(),
    block_number: z.int().nullable(),
    neuron_count: z.int().min(0),
    validator_count: z.int().min(0),
    miner_count: z.int().min(0),
    total_stake_tao: z.number(),
    total_emission_tao: z.number(),
    subnet_yield: z.number().nullable(),
    mean_yield: z.number().nullable(),
    median_yield: z.number().nullable(),
    p25_yield: z.number().nullable(),
    p75_yield: z.number().nullable(),
    p90_yield: z.number().nullable(),
    neurons: z.array(SubnetYieldNeuronSchema),
  })
  .strict();
export type SubnetYieldArtifact = z.infer<typeof SubnetYieldArtifactSchema>;
export const SubnetYieldResponseSchema = successEnvelopeSchema(
  SubnetYieldArtifactSchema,
);
export const SubnetYieldQuerySchema = z.object({}).strict();
export type SubnetYieldQuery = z.infer<typeof SubnetYieldQuerySchema>;

const SubnetYieldHistoryPointSchema = z
  .object({
    snapshot_date: z.string(),
    neuron_count: z.int().min(0).optional(),
    validator_count: z.int().min(0).optional(),
    yield_count: z.int().min(0).optional(),
    subnet_yield: z.number().nullable().optional(),
    mean_yield: z.number().nullable().optional(),
    median_yield: z.number().nullable().optional(),
    p25_yield: z.number().nullable().optional(),
    p75_yield: z.number().nullable().optional(),
    p90_yield: z.number().nullable().optional(),
  })
  .passthrough();

export const SubnetYieldHistoryArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    window: z.string().nullable().optional(),
    point_count: z.int().min(0),
    points: z.array(SubnetYieldHistoryPointSchema),
  })
  .passthrough();
export type SubnetYieldHistoryArtifact = z.infer<
  typeof SubnetYieldHistoryArtifactSchema
>;
export const SubnetYieldHistoryResponseSchema = successEnvelopeSchema(
  SubnetYieldHistoryArtifactSchema,
);
export const SubnetYieldHistoryQuerySchema = z
  .object({
    window: z.enum(["7d", "30d", "90d"]).optional(),
  })
  .strict();
export type SubnetYieldHistoryQuery = z.infer<
  typeof SubnetYieldHistoryQuerySchema
>;
