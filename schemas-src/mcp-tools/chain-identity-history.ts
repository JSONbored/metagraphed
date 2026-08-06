// MCP tool `get_chain_identity_history` (types-epic E batch 9, #8072).
// Mirrors GET /api/v1/chain/identity-history, which is not one of
// schemas-src/routes/'s covered pilot routes -- no existing Zod schema to
// reuse. Modeled fresh, matching the hand-written literal it replaces
// field-for-field.
import { z } from "zod";
import {
  CHAIN_IDENTITY_HISTORY_LIMIT_DEFAULT,
  CHAIN_IDENTITY_HISTORY_LIMIT_MAX,
} from "../../src/route-limits.ts";
import { limitSchema, netuidSchema } from "./shared.ts";

export const GetChainIdentityHistoryInputSchema = z
  .object({
    limit: limitSchema(
      CHAIN_IDENTITY_HISTORY_LIMIT_MAX,
      CHAIN_IDENTITY_HISTORY_LIMIT_DEFAULT,
    ).optional(),
  })
  .strict();
export type GetChainIdentityHistoryInput = z.infer<
  typeof GetChainIdentityHistoryInputSchema
>;

// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note from the pilot batch).
const ChainIdentityChangeSchema = z
  .object({
    netuid: netuidSchema().nullable().optional(),
    block_number: z.int().nullable().optional(),
    observed_at: z.string().nullable().optional(),
    subnet_name: z.string().nullable().optional(),
    symbol: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    github_repo: z.string().nullable().optional(),
    subnet_url: z.string().nullable().optional(),
    discord: z.string().nullable().optional(),
    logo_url: z.string().nullable().optional(),
    identity_hash: z.string().nullable().optional(),
  })
  .passthrough();

export const GetChainIdentityHistoryOutputSchema = z
  .object({
    schema_version: z.int(),
    count: z.int(),
    subnet_count: z.int(),
    changes: z.array(ChainIdentityChangeSchema),
  })
  .passthrough();
export type GetChainIdentityHistoryOutput = z.infer<
  typeof GetChainIdentityHistoryOutputSchema
>;
