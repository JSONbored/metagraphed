// MCP tools `get_account`, `get_account_entities`, `get_account_events`,
// `get_account_subnets` (types-epic E batch 6, #8069). Each mirrors a
// GET /api/v1/accounts/{ss58}* route that is not one of schemas-src/routes/'s
// covered pilot routes -- no existing Zod schema to reuse. AccountEventItem/
// AccountRegistrationItem are deliberately NOT the same as any REST
// schemas-src/routes/ AccountEvent-style schema (none exist yet for this
// domain): modeled fresh, matching each hand-written literal (and the
// shared ACCOUNT_EVENT_ITEM/ACCOUNT_REGISTRATION_ITEM object literals
// src/mcp-server.ts's objectItems() wraps) field-for-field.
import { z } from "zod";
import { OpenObjectSchema } from "./shared.ts";

const Ss58Schema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{47,48}$/);

// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note from the pilot batch).
const AccountEventItemSchema = z
  .object({
    block_number: z.int().nullable().optional(),
    event_index: z.int().nullable().optional(),
    event_kind: z.string().nullable().optional(),
    hotkey: z.string().nullable().optional(),
    coldkey: z.string().nullable().optional(),
    netuid: z.int().nullable().optional(),
    uid: z.int().nullable().optional(),
    amount_tao: z.unknown().optional(),
    alpha_amount: z.unknown().optional(),
    observed_at: z.string().nullable().optional(),
    extrinsic_index: z.int().nullable().optional(),
  })
  .passthrough();

const AccountRegistrationItemSchema = z
  .object({
    netuid: z.int().nullable().optional(),
    uid: z.int().nullable().optional(),
    stake_tao: z.unknown().optional(),
    validator_permit: z.boolean().optional(),
    active: z.boolean().optional(),
  })
  .passthrough();

const AccountLabelItemSchema = z
  .object({
    name: z.string().nullable().optional(),
    category: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    source_urls: z.array(z.string()).optional(),
  })
  .passthrough();

export const GetAccountInputSchema = z
  .object({
    ss58: Ss58Schema,
  })
  .strict();
export type GetAccountInput = z.infer<typeof GetAccountInputSchema>;

export const GetAccountOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    ss58: z.string(),
    event_count: z.int(),
    subnet_count: z.int(),
    first_block: z.int().nullable().optional(),
    last_block: z.int().nullable().optional(),
    first_seen_at: z.string().nullable().optional(),
    last_seen_at: z.string().nullable().optional(),
    event_kinds: z.array(
      z
        .object({
          kind: z.string().optional(),
          count: z.int().optional(),
        })
        .passthrough(),
    ),
    registrations: z.array(AccountRegistrationItemSchema),
    recent_events: z.array(AccountEventItemSchema),
    activity: OpenObjectSchema.optional(),
    labels: z.array(AccountLabelItemSchema).optional(),
  })
  .passthrough();
export type GetAccountOutput = z.infer<typeof GetAccountOutputSchema>;

export const GetAccountEntitiesInputSchema = z
  .object({
    ss58: Ss58Schema,
  })
  .strict();
export type GetAccountEntitiesInput = z.infer<
  typeof GetAccountEntitiesInputSchema
>;

export const GetAccountEntitiesOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    ss58: z.string(),
    labels: z.array(AccountLabelItemSchema),
    ownership_tie_count: z.int(),
    ownership_ties: z.array(
      z
        .object({
          netuid: z.int().nullable().optional(),
          role: z.string().optional(),
          block_number: z.int().nullable().optional(),
          observed_at: z.string().nullable().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
export type GetAccountEntitiesOutput = z.infer<
  typeof GetAccountEntitiesOutputSchema
>;

export const GetAccountEventsInputSchema = z
  .object({
    ss58: Ss58Schema,
    kind: z.string().optional(),
    netuid: z.int().min(0).optional(),
    block_start: z.int().min(0).optional(),
    block_end: z.int().min(0).optional(),
    limit: z.int().min(1).max(1000).optional(),
    offset: z.int().min(0).optional(),
    cursor: z.string().optional(),
  })
  .strict();
export type GetAccountEventsInput = z.infer<typeof GetAccountEventsInputSchema>;

export const GetAccountEventsOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    ss58: z.string(),
    event_count: z.int(),
    limit: z.int().nullable().optional(),
    offset: z.int().nullable().optional(),
    next_cursor: z.string().nullable().optional(),
    events: z.array(AccountEventItemSchema),
  })
  .passthrough();
export type GetAccountEventsOutput = z.infer<
  typeof GetAccountEventsOutputSchema
>;

export const GetAccountSubnetsInputSchema = z
  .object({
    ss58: Ss58Schema,
  })
  .strict();
export type GetAccountSubnetsInput = z.infer<
  typeof GetAccountSubnetsInputSchema
>;

export const GetAccountSubnetsOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    ss58: z.string(),
    subnet_count: z.int(),
    subnets: z.array(AccountRegistrationItemSchema),
  })
  .passthrough();
export type GetAccountSubnetsOutput = z.infer<
  typeof GetAccountSubnetsOutputSchema
>;
