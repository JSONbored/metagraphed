// GET /api/v1/validators/{hotkey} (types-epic B batch 7, #8061). Live
// neurons D1-tier data -- no static file. Modeled from
// src/metagraph-neurons.ts's buildValidatorDetail() (which builds each
// subnets[] entry via formatNeuron(row) with no featuredHotkeys/
// immunityPeriod, so every neuron field is always set, never omitted),
// cross-checked against the hand-edited ValidatorDetailArtifact component
// it replaces. Reuses ColdkeyIdentitySchema from global-validators.ts.
//
// ValidatorDetailSubnetSchema is exported (not registered) so
// compare-validators.ts can reuse it for CompareValidatorEntry's
// subnet_context -- ValidatorDetailSubnet's only 2 hand-edited referrers
// (ValidatorDetailArtifact, CompareValidatorEntry) are both converted in
// this same batch (verified via repo-wide $ref grep), so the hand-edited
// component key becomes fully orphaned.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";
import { ColdkeyIdentitySchema } from "./global-validators.ts";

export const ValidatorDetailSubnetSchema = z
  .object({
    netuid: z.int().min(0),
    uid: z.int().min(0),
    hotkey: z.string().nullable(),
    coldkey: z.string().nullable(),
    active: z.boolean(),
    validator_permit: z.boolean(),
    rank: z.number().nullable(),
    trust: z.number().nullable(),
    validator_trust: z.number().nullable(),
    consensus: z.number().nullable(),
    incentive: z.number().nullable(),
    dividends: z.number().nullable(),
    emission_tao: z.number().nullable(),
    stake_tao: z.number().nullable(),
    registered_at_block: z.int().min(0).nullable(),
    is_immunity_period: z.boolean(),
    axon: z.string().nullable(),
    take: z.number().nullable(),
  })
  .strict();

export const ValidatorDetailArtifactSchema = z
  .object({
    schema_version: z.int(),
    hotkey: z.string(),
    coldkey: z.string().nullable(),
    coldkey_identity: ColdkeyIdentitySchema.nullable(),
    coldkey_count: z.int().min(0),
    subnet_count: z.int().min(0),
    take: z.number().nullable(),
    total_stake_tao: z.number().min(0),
    root_stake_tao: z.number().min(0),
    alpha_stake_tao: z.number().min(0),
    total_emission_tao: z.number().min(0),
    nominator_count: z.int().min(0).nullable(),
    apy_estimate: z.number().min(0).nullable(),
    apy_estimate_eligible_subnet_count: z.int().min(0),
    realized_return_1d: z.number().nullable(),
    realized_return_1w: z.number().nullable(),
    realized_return_1m: z.number().nullable(),
    avg_validator_trust: z.number().nullable(),
    max_validator_trust: z.number().nullable(),
    captured_at: z.string().nullable(),
    block_number: z.int().min(0).nullable(),
    subnets: z.array(ValidatorDetailSubnetSchema),
  })
  .passthrough();
export type ValidatorDetailArtifact = z.infer<
  typeof ValidatorDetailArtifactSchema
>;
export const ValidatorDetailResponseSchema = successEnvelopeSchema(
  ValidatorDetailArtifactSchema,
);
export const ValidatorDetailQuerySchema = z.object({}).strict();
export type ValidatorDetailQuery = z.infer<typeof ValidatorDetailQuerySchema>;
