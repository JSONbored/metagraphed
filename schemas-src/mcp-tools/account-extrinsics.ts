// MCP tool `get_account_extrinsics` (types-epic E batch 7, #8070). Mirrors
// GET /api/v1/accounts/{ss58}/extrinsics, which is not one of
// schemas-src/routes/'s covered pilot routes -- no existing Zod schema to
// reuse. The extrinsics item shape mirrors src/mcp-server.ts's shared
// EXTRINSIC_ITEM object literal (also used by list_extrinsics/get_extrinsic/
// get_block_extrinsics, none of which are in this batch) -- modeled fresh
// here rather than importing a shared schema, since those other tools stay
// hand-written JSON Schema for now and EXTRINSIC_ITEM itself has no Zod
// equivalent yet.
import { z } from "zod";
import {
  blockBoundSchema,
  keysetCursorSchema,
  limitSchema,
  offsetSchema,
  ss58Schema,
} from "./shared.ts";

export const GetAccountExtrinsicsInputSchema = z
  .object({
    ss58: ss58Schema(),
    block_start: blockBoundSchema("first").optional(),
    block_end: blockBoundSchema("last").optional(),
    limit: limitSchema(1000).optional(),
    offset: offsetSchema().optional(),
    cursor: keysetCursorSchema().optional(),
  })
  .strict();
export type GetAccountExtrinsicsInput = z.infer<
  typeof GetAccountExtrinsicsInputSchema
>;

// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note from the pilot batch).
const ExtrinsicItemSchema = z
  .object({
    block_number: z.int().nullable().optional(),
    extrinsic_index: z.int().nullable().optional(),
    extrinsic_hash: z.string().nullable().optional(),
    signer: z.string().nullable().optional(),
    call_module: z.string().nullable().optional(),
    call_function: z.string().nullable().optional(),
    call_args: z.unknown().optional(),
    success: z.boolean().nullable().optional(),
    fee_tao: z.unknown().optional(),
    tip_tao: z.unknown().optional(),
    observed_at: z.string().nullable().optional(),
    // #8525: deterministic human-readable action sentence for this
    // extrinsic's call, or null when no template matches
    // call_module.call_function -- never a guessed/partial sentence.
    summary: z.string().nullable().optional(),
  })
  .passthrough();

export const GetAccountExtrinsicsOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    ss58: z.string(),
    extrinsic_count: z.int(),
    limit: z.int().nullable().optional(),
    offset: z.int().nullable().optional(),
    next_cursor: z.string().nullable().optional(),
    extrinsics: z.array(ExtrinsicItemSchema),
  })
  .passthrough();
export type GetAccountExtrinsicsOutput = z.infer<
  typeof GetAccountExtrinsicsOutputSchema
>;
