// MCP tool `get_account_history` (types-epic E batch 7, #8070). Mirrors
// GET /api/v1/accounts/{ss58}/history, which is not one of
// schemas-src/routes/'s covered pilot routes -- no existing Zod schema to
// reuse. Modeled fresh, matching the hand-written literal it replaces
// field-for-field.
import { z } from "zod";

const Ss58Schema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{47,48}$/);

export const GetAccountHistoryInputSchema = z
  .object({
    ss58: Ss58Schema,
    netuid: z.int().min(0).optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    limit: z.int().min(1).max(1000).optional(),
    offset: z.int().min(0).optional(),
    cursor: z.string().optional(),
  })
  .strict();
export type GetAccountHistoryInput = z.infer<
  typeof GetAccountHistoryInputSchema
>;

// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note from the pilot batch).
const AccountHistoryDaySchema = z
  .object({
    day: z.string().nullable().optional(),
    netuid: z.int().nullable().optional(),
    event_count: z.int().nullable().optional(),
    event_kinds: z.array(z.string()).optional(),
    first_block: z.int().nullable().optional(),
    last_block: z.int().nullable().optional(),
  })
  .passthrough();

export const GetAccountHistoryOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    ss58: z.string(),
    day_count: z.int(),
    limit: z.int().nullable().optional(),
    offset: z.int().nullable().optional(),
    days: z.array(AccountHistoryDaySchema),
  })
  .passthrough();
export type GetAccountHistoryOutput = z.infer<
  typeof GetAccountHistoryOutputSchema
>;
