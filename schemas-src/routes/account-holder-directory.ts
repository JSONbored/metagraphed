import { z } from "zod";
import { ACCOUNT_HOLDER_DIRECTORY_LIMIT } from "../../src/account-holder-directory.ts";

export const AccountHolderDirectoryEntrySchema = z
  .object({
    hotkey: z.string(),
    coldkey: z.string().nullable(),
    subnet_count: z.int().min(0),
    uid_count: z.int().min(0),
    total_stake_tao: z.number().min(0),
    total_emission_tao: z.number().min(0),
    stake_dominance: z.number().min(0).max(1).nullable(),
  })
  .strict();

const RankingSchema = z
  .array(AccountHolderDirectoryEntrySchema)
  .max(ACCOUNT_HOLDER_DIRECTORY_LIMIT);

export const AccountHolderDirectoryArtifactSchema = z
  .object({
    schema_version: z.literal(1),
    captured_at: z.string().nullable(),
    block_number: z.int().min(0).nullable(),
    account_count: z.int().min(0),
    limit: z.literal(ACCOUNT_HOLDER_DIRECTORY_LIMIT),
    priced_registered_stake_tao: z.number().min(0),
    rankings: z
      .object({
        stake: RankingSchema,
        emission: RankingSchema,
        reach: RankingSchema,
      })
      .strict(),
  })
  .strict();
