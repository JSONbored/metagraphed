// MCP tools `get_account_identity`, `get_account_identity_history`
// (types-epic E batch 6, #8069). Each mirrors a GET /api/v1/accounts/{ss58}/
// identity* route that is not one of schemas-src/routes/'s covered pilot
// routes -- no existing Zod schema to reuse. Modeled fresh, matching each
// hand-written literal field-for-field.
import { z } from "zod";

const Ss58Schema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{47,48}$/);

export const GetAccountIdentityInputSchema = z
  .object({
    ss58: Ss58Schema,
  })
  .strict();
export type GetAccountIdentityInput = z.infer<
  typeof GetAccountIdentityInputSchema
>;

export const GetAccountIdentityOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    account: z.string(),
    has_identity: z.boolean(),
    name: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    github: z.string().nullable().optional(),
    image: z.string().nullable().optional(),
    discord: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    additional: z.string().nullable().optional(),
    captured_at: z.string().nullable().optional(),
  })
  .passthrough();
export type GetAccountIdentityOutput = z.infer<
  typeof GetAccountIdentityOutputSchema
>;

export const GetAccountIdentityHistoryInputSchema = z
  .object({
    ss58: Ss58Schema,
    limit: z.int().min(1).max(1000).optional(),
    offset: z.int().min(0).optional(),
    cursor: z.string().optional(),
  })
  .strict();
export type GetAccountIdentityHistoryInput = z.infer<
  typeof GetAccountIdentityHistoryInputSchema
>;

// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note from the pilot batch) -- except
// identity_hash, which is a real finding (bucket b), same root cause
// #8055/#8067 already found and fixed for the subnet-scoped identity
// history: formatAccountIdentityHistoryEntry() (src/account-identity-
// history.ts) unconditionally sets `entry.identity_hash = row.identity_hash
// ?? null`, so the key itself is always present even though the hand-
// written original never required it. Modeled here as nullable (still
// required), matching real behavior.
const AccountIdentityHistoryEntrySchema = z
  .object({
    observed_at: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    github: z.string().nullable().optional(),
    image: z.string().nullable().optional(),
    discord: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    additional: z.string().nullable().optional(),
    identity_hash: z.string().nullable(),
  })
  .passthrough();

export const GetAccountIdentityHistoryOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    account: z.string(),
    entry_count: z.int(),
    limit: z.int().nullable().optional(),
    offset: z.int().nullable().optional(),
    next_cursor: z.string().nullable().optional(),
    entries: z.array(AccountIdentityHistoryEntrySchema),
  })
  .passthrough();
export type GetAccountIdentityHistoryOutput = z.infer<
  typeof GetAccountIdentityHistoryOutputSchema
>;
