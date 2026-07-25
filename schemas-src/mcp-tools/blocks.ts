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
} from "./shared.ts";

const Ss58Schema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{47,48}$/);

export const ListBlocksInputSchema = z
  .object({
    author: Ss58Schema.optional(),
    spec_version: z.int().min(0).optional(),
    block_start: z.int().min(0).optional(),
    block_end: z.int().min(0).optional(),
    from: z.int().min(0).optional(),
    to: z.int().min(0).optional(),
    min_extrinsics: z.int().min(0).optional(),
    min_events: z.int().min(0).optional(),
    limit: z.int().min(1).max(100).optional(),
    offset: z.int().min(0).optional(),
    cursor: z.string().optional(),
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
    ref: z.string(),
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
    ref: z.string(),
    limit: z.int().min(1).max(100).optional(),
    offset: z.int().min(0).optional(),
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
    ref: z.string(),
    limit: z.int().min(1).max(1000).optional(),
    offset: z.int().min(0).optional(),
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
