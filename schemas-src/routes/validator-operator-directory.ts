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
    operator_id: z
      .string()
      .optional()
      .describe(
        "Stable identifier within the response network: coldkey:<address> for an observed single-owner group, otherwise hotkey:<address>. Independent of declared name, ranking and primary-hotkey selection. Optional only for older cached responses; callers must include network in cross-network keys.",
      ),
    ownership_basis: z
      .enum(["single_coldkey", "ambiguous", "unknown"])
      .optional()
      .describe(
        "single_coldkey means every member has exactly one observed owner and all members share that owner account. This is snapshot ownership agreement, not verified branding or organizational identity. ambiguous means multiple owners were observed for a singleton hotkey; unknown means ownership evidence is absent or unusable. Missing on older cached responses means unknown, never verified.",
      ),
    identity_name: z.string().nullable(),
    hotkeys: z.array(ValidatorOperatorKeySchema),
    hotkey_count: z.int().min(1),
    primary_hotkey: z.string(),
    coldkey: z
      .string()
      .nullable()
      .describe(
        "The source-selected owner account of the primary hotkey. Common to all members only when ownership_basis is single_coldkey; otherwise this is a representative source field, not evidence of shared ownership.",
      ),
    total_stake_tao: z.number().min(0),
    total_emission_tao: z.number().min(0),
    nominator_count: z
      .int()
      .min(0)
      .nullable()
      .describe(
        "Distinct nominator accounts (coldkeys) for a singleton operator, from its hotkey's available count. Always null for multiple hotkeys: per-hotkey counts cannot deduplicate overlapping accounts or establish complete operator coverage. Accounts are not people, and null is unavailable rather than zero.",
      ),
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
