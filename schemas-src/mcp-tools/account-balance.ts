// MCP tool `get_account_balance` (types-epic E batch 6, #8069). Mirrors
// GET /api/v1/accounts/{ss58}/balance, which is not one of
// schemas-src/routes/'s covered pilot routes -- no existing Zod schema to
// reuse. Modeled fresh, matching the hand-written literal it replaces
// field-for-field.
import { z } from "zod";

const Ss58Schema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{47,48}$/);

export const GetAccountBalanceInputSchema = z
  .object({
    ss58: Ss58Schema,
  })
  .strict();
export type GetAccountBalanceInput = z.infer<
  typeof GetAccountBalanceInputSchema
>;

export const GetAccountBalanceOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    ss58: z.string(),
    balance_tao: z.number().nullable(),
    queried_at: z.string().nullable(),
  })
  .passthrough();
export type GetAccountBalanceOutput = z.infer<
  typeof GetAccountBalanceOutputSchema
>;
