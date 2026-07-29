// MCP tools `get_block_chain_events`, `get_extrinsic_chain_events`
// (types-epic E batch 8, #8071). Each mirrors a GET /api/v1/{blocks/*/chain-
// events,chain-events} route that is not one of schemas-src/routes/'s
// covered pilot routes -- no existing Zod schema to reuse. Modeled fresh,
// matching each hand-written literal field-for-field.
import { z } from "zod";

export const GetBlockChainEventsInputSchema = z
  .object({
    block_number: z.int().min(0),
  })
  .strict();
export type GetBlockChainEventsInput = z.infer<
  typeof GetBlockChainEventsInputSchema
>;

// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note from the pilot batch). observed_at here is
// a plain nullable INTEGER (epoch ms), unlike the nullable STRING timestamp
// convention every other item shape in this epic uses -- the hand-written
// original's CHAIN_EVENT_ITEM literally wraps it in NULLABLE_INT, not
// NULLABLE_STRING.
const ChainEventItemSchema = z
  .object({
    block_number: z.int().nullable().optional(),
    event_index: z.int().nullable().optional(),
    pallet: z.string().nullable().optional(),
    method: z.string().nullable().optional(),
    args: z.unknown().optional(),
    phase: z.unknown().optional(),
    extrinsic_index: z.int().nullable().optional(),
    observed_at: z.int().nullable().optional(),
    // #8525: deterministic human-readable action sentence for this event's
    // pallet.method, or null when no template matches -- never a
    // guessed/partial sentence.
    summary: z.string().nullable().optional(),
  })
  .passthrough();

export const GetBlockChainEventsOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    block_number: z.int().nullable(),
    event_count: z.int(),
    events: z.array(ChainEventItemSchema),
  })
  .passthrough();
export type GetBlockChainEventsOutput = z.infer<
  typeof GetBlockChainEventsOutputSchema
>;

export const GetExtrinsicChainEventsInputSchema = z
  .object({
    ref: z.string(),
    limit: z.int().min(1).max(200).optional(),
    cursor: z.string().optional(),
  })
  .strict();
export type GetExtrinsicChainEventsInput = z.infer<
  typeof GetExtrinsicChainEventsInputSchema
>;

export const GetExtrinsicChainEventsOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    ref: z.unknown(),
    block_number: z.int().nullable(),
    extrinsic_index: z.int().nullable(),
    limit: z.int().nullable().optional(),
    event_count: z.int(),
    next_cursor: z.string().nullable().optional(),
    events: z.array(ChainEventItemSchema),
  })
  .passthrough();
export type GetExtrinsicChainEventsOutput = z.infer<
  typeof GetExtrinsicChainEventsOutputSchema
>;
