import { z } from "zod";

export const ValidatorOperatorKeySchema = z
  .object({
    hotkey: z.string(),
    total_stake_tao: z.number().min(0),
    take: z.number().nullable(),
  })
  .strict();

export const ValidatorOperatorDirectoryEntrySchema = z
  .object({
    identity_name: z.string().nullable(),
    hotkeys: z.array(ValidatorOperatorKeySchema),
    hotkey_count: z.int().min(1),
    primary_hotkey: z.string(),
    coldkey: z.string().nullable(),
    total_stake_tao: z.number().min(0),
    total_emission_tao: z.number().min(0),
    nominator_count: z.int().min(0).nullable(),
    membership_count: z.int().min(0),
    uid_count: z.int().min(0),
    take_min: z.number().nullable(),
    take_max: z.number().nullable(),
    apy_estimate: z.number().min(0).nullable(),
    stake_dominance: z.number().min(0).max(1).nullable(),
  })
  .strict();

export const ValidatorOperatorDirectoryArtifactSchema = z
  .object({
    schema_version: z.literal(1),
    captured_at: z.string().nullable(),
    block_number: z.int().min(0).nullable(),
    validator_count: z.int().min(0),
    operator_count: z.int().min(0),
    operators: z.array(ValidatorOperatorDirectoryEntrySchema),
  })
  .strict();

export type ValidatorOperatorDirectoryArtifact = z.infer<
  typeof ValidatorOperatorDirectoryArtifactSchema
>;
