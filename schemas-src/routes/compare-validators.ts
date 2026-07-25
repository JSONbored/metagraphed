// GET /api/v1/compare/validators (types-epic B batch 7, #8061). Live
// neurons D1-tier data -- no static file. Modeled from
// src/metagraph-neurons.ts's composeValidatorComparison() (the decision-
// relevant projection of buildValidatorDetail() for each requested hotkey),
// cross-checked against the hand-edited CompareValidatorsArtifact component
// it replaces. Reuses ColdkeyIdentitySchema from global-validators.ts and
// ValidatorDetailSubnetSchema from validator-detail.ts (subnet_context).
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";
import { ColdkeyIdentitySchema } from "./global-validators.ts";
import { ValidatorDetailSubnetSchema } from "./validator-detail.ts";

const CompareValidatorEntrySchema = z
  .object({
    hotkey: z.string(),
    coldkey: z.string().nullable(),
    coldkey_identity: ColdkeyIdentitySchema.nullable(),
    take: z.number().nullable(),
    apy_estimate: z.number().min(0).nullable(),
    apy_estimate_eligible_subnet_count: z.int().min(0),
    nominator_count: z.int().min(0).nullable(),
    total_stake_tao: z.number().min(0),
    total_emission_tao: z.number().min(0),
    avg_validator_trust: z.number().nullable(),
    max_validator_trust: z.number().nullable(),
    subnet_count: z.int().min(0),
    subnet_context: ValidatorDetailSubnetSchema.nullable(),
  })
  .strict();

export const CompareValidatorsArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0).nullable(),
    validator_count: z.int().min(0),
    validators: z.array(CompareValidatorEntrySchema),
  })
  .passthrough();
export type CompareValidatorsArtifact = z.infer<
  typeof CompareValidatorsArtifactSchema
>;
export const CompareValidatorsResponseSchema = successEnvelopeSchema(
  CompareValidatorsArtifactSchema,
);
export const CompareValidatorsQuerySchema = z
  .object({
    hotkeys: z.string(),
    netuid: z.int().min(0).optional(),
  })
  .strict();
export type CompareValidatorsQuery = z.infer<
  typeof CompareValidatorsQuerySchema
>;
