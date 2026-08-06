// MCP tools `get_account_transfers`, `get_account_counterparties`
// (types-epic E batch 7, #8070). Each mirrors a GET /api/v1/accounts/{ss58}/
// {transfers,counterparties} route that is not one of schemas-src/routes/'s
// covered pilot routes -- no existing Zod schema to reuse. Modeled fresh,
// matching each hand-written literal field-for-field.
import { z } from "zod";
import {
  OpenObjectSchema,
  blockBoundSchema,
  keysetCursorSchema,
  limitSchema,
  offsetSchema,
  ss58Schema,
} from "./shared.ts";

const Ss58Schema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{47,48}$/);

export const GetAccountTransfersInputSchema = z
  .object({
    ss58: ss58Schema(),
    direction: z
      .enum(["all", "sent", "received"])
      .optional()
      .describe(
        "Which side of the flow to include: everything, only outgoing, or only incoming.",
      )
      .meta({ examples: ["all"] }),
    block_start: blockBoundSchema("first").optional(),
    block_end: blockBoundSchema("last").optional(),
    limit: limitSchema(1000).optional(),
    offset: offsetSchema().optional(),
    cursor: keysetCursorSchema().optional(),
  })
  .strict();
export type GetAccountTransfersInput = z.infer<
  typeof GetAccountTransfersInputSchema
>;

// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note from the pilot batch).
const AccountTransferItemSchema = z
  .object({
    block_number: z.int().nullable().optional(),
    event_index: z.int().nullable().optional(),
    from: z.string().nullable().optional(),
    to: z.string().nullable().optional(),
    amount_tao: z.unknown().optional(),
    direction: z.string().nullable().optional(),
    observed_at: z.string().nullable().optional(),
  })
  .passthrough();

export const GetAccountTransfersOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    ss58: z.string(),
    transfer_count: z.int(),
    limit: z.int().nullable().optional(),
    offset: z.int().nullable().optional(),
    next_cursor: z.string().nullable().optional(),
    transfers: z.array(AccountTransferItemSchema),
  })
  .passthrough();
export type GetAccountTransfersOutput = z.infer<
  typeof GetAccountTransfersOutputSchema
>;

export const GetAccountCounterpartiesInputSchema = z
  .object({
    ss58: ss58Schema(),
    counterparty: Ss58Schema.optional()
      .describe(
        "The other SS58 account in the transfer pair — results are restricted to flows between the subject account and this one.",
      )
      .meta({ examples: ["5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F"] }),
    limit: limitSchema(100).optional(),
  })
  .strict();
export type GetAccountCounterpartiesInput = z.infer<
  typeof GetAccountCounterpartiesInputSchema
>;

// objectItems(...) properties, none required at the item level.
const CounterpartyItemSchema = z
  .object({
    address: z.string().nullable().optional(),
    sent_tao: z.unknown().optional(),
    received_tao: z.unknown().optional(),
    net_tao: z.unknown().optional(),
    transfer_count: z.int().nullable().optional(),
    last_block: z.int().nullable().optional(),
  })
  .passthrough();

export const GetAccountCounterpartiesOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    ss58: z.string(),
    counterparty_count: z.int(),
    transfers_scanned: z.int().nullable().optional(),
    scan_capped: z.boolean().optional(),
    total_sent_tao: z.unknown().optional(),
    total_received_tao: z.unknown().optional(),
    counterparties: z.array(CounterpartyItemSchema),
    // Present only in counterparty='<ss58>' drilldown mode (the per-pair
    // detail) -- bare open object, matching the hand-written original.
    relationship: OpenObjectSchema.optional(),
  })
  .passthrough();
export type GetAccountCounterpartiesOutput = z.infer<
  typeof GetAccountCounterpartiesOutputSchema
>;
