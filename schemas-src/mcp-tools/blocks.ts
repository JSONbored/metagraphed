// MCP tools `list_blocks`, `get_block`, `list_block_extrinsics`,
// `get_block_events` (types-epic E batch 8, #8071). Each mirrors a
// GET /api/v1/blocks* route that is not one of schemas-src/routes/'s covered
// pilot routes -- no existing Zod schema to reuse. Modeled fresh, matching
// each hand-written literal field-for-field.
import { z } from "zod";
import {
  AccountEventItemSchema,
  ExtrinsicItemSchema,
  OpenObjectSchema,
  blockBoundSchema,
  keysetCursorSchema,
  limitSchema,
  offsetSchema,
} from "./shared.ts";

const Ss58Schema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{47,48}$/);

export const ListBlocksInputSchema = z
  .object({
    author: Ss58Schema.optional()
      .describe(
        "Restrict to blocks authored by this SS58 validator hotkey. Only populated below the decode watermark; recent head blocks may not carry an author yet.",
      )
      .meta({ examples: ["5CS3g6nVJM6ouns8n9buN9CzFf2C1YDHVcVGRcxoirKs2xbV"] }),
    spec_version: z
      .int()
      .min(0)
      .optional()
      .describe(
        "Restrict to blocks running this runtime spec version — the number that changes at a runtime upgrade.",
      )
      .meta({ examples: [441] }),
    block_start: blockBoundSchema("first").optional(),
    block_end: blockBoundSchema("last").optional(),
    from: z
      .int()
      .min(0)
      .optional()
      .describe(
        "Inclusive start of the range. A block height on chain tools, an ISO-8601 date on time-series ones.",
      )
      .meta({ examples: [8700000] }),
    to: z
      .int()
      .min(0)
      .optional()
      .describe(
        "Inclusive end of the range. A block height on chain tools, an ISO-8601 date on time-series ones; an EVM address on decode_evm_call.",
      )
      .meta({ examples: [8783000] }),
    min_extrinsics: z
      .int()
      .min(0)
      .optional()
      .describe(
        "Inclusive lower bound on a block's extrinsic count; quieter blocks are excluded.",
      )
      .meta({ examples: [5] }),
    min_events: z
      .int()
      .min(0)
      .optional()
      .describe(
        "Inclusive lower bound on a block's event count; quieter blocks are excluded.",
      )
      .meta({ examples: [20] }),
    limit: limitSchema(100).optional(),
    offset: offsetSchema().optional(),
    cursor: keysetCursorSchema().optional(),
  })
  .strict();
export type ListBlocksInput = z.infer<typeof ListBlocksInputSchema>;

// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note from the pilot batch).
const BlockItemSchema = z
  .object({
    block_number: z.int().nullable().optional(),
    block_hash: z.string().nullable().optional(),
    parent_hash: z.string().nullable().optional(),
    author: z.string().nullable().optional(),
    extrinsic_count: z.int().nullable().optional(),
    event_count: z.int().nullable().optional(),
    spec_version: z.int().nullable().optional(),
    observed_at: z.string().nullable().optional(),
  })
  .passthrough();

export const ListBlocksOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    block_count: z.int(),
    limit: z.int().nullable().optional(),
    offset: z.int().nullable().optional(),
    next_cursor: z.string().nullable().optional(),
    blocks: z.array(BlockItemSchema),
  })
  .passthrough();
export type ListBlocksOutput = z.infer<typeof ListBlocksOutputSchema>;

export const GetBlockInputSchema = z
  .object({
    ref: z
      .string()
      .describe(
        "Block reference: either a block NUMBER or a 0x-prefixed block HASH. Both forms are accepted and resolve to the same block.",
      )
      .meta({ examples: ["8783000", "0x9f1e...c3"] }),
  })
  .strict();
export type GetBlockInput = z.infer<typeof GetBlockInputSchema>;

export const GetBlockOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    ref: z.unknown(),
    block: OpenObjectSchema.nullable().optional(),
    prev_block_number: z.int().nullable().optional(),
    next_block_number: z.int().nullable().optional(),
  })
  .passthrough();
export type GetBlockOutput = z.infer<typeof GetBlockOutputSchema>;

export const ListBlockExtrinsicsInputSchema = z
  .object({
    ref: z
      .string()
      .describe(
        "Block reference: either a block NUMBER or a 0x-prefixed block HASH. Both forms are accepted and resolve to the same block.",
      )
      .meta({ examples: ["8783000", "0x9f1e...c3"] }),
    limit: limitSchema(100).optional(),
    offset: offsetSchema().optional(),
  })
  .strict();
export type ListBlockExtrinsicsInput = z.infer<
  typeof ListBlockExtrinsicsInputSchema
>;

export const ListBlockExtrinsicsOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    ref: z.unknown(),
    block_number: z.int().nullable().optional(),
    extrinsic_count: z.int(),
    limit: z.int().nullable().optional(),
    offset: z.int().nullable().optional(),
    extrinsics: z.array(ExtrinsicItemSchema),
  })
  .passthrough();
export type ListBlockExtrinsicsOutput = z.infer<
  typeof ListBlockExtrinsicsOutputSchema
>;

export const GetBlockEventsInputSchema = z
  .object({
    ref: z
      .string()
      .describe(
        "Block reference: either a block NUMBER or a 0x-prefixed block HASH. Both forms are accepted and resolve to the same block.",
      )
      .meta({ examples: ["8783000", "0x9f1e...c3"] }),
    limit: limitSchema(1000).optional(),
    offset: offsetSchema().optional(),
  })
  .strict();
export type GetBlockEventsInput = z.infer<typeof GetBlockEventsInputSchema>;

export const GetBlockEventsOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    ref: z.unknown(),
    block_number: z.int().nullable().optional(),
    event_count: z.int(),
    limit: z.int().nullable().optional(),
    offset: z.int().nullable().optional(),
    events: z.array(AccountEventItemSchema),
  })
  .passthrough();
export type GetBlockEventsOutput = z.infer<typeof GetBlockEventsOutputSchema>;
