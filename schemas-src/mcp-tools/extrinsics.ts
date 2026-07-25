// MCP tools `list_extrinsics`, `get_extrinsic` (types-epic E batch 8,
// #8071). Each mirrors a GET /api/v1/extrinsics* route that is not one of
// schemas-src/routes/'s covered pilot routes -- no existing Zod schema to
// reuse. Modeled fresh, matching each hand-written literal field-for-field.
import { z } from "zod";
import {
  AccountEventItemSchema,
  ExtrinsicItemSchema,
  OpenObjectSchema,
} from "./shared.ts";

const Ss58Schema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{47,48}$/);

export const ListExtrinsicsInputSchema = z
  .object({
    block: z.int().min(0).optional(),
    signer: Ss58Schema.optional(),
    call_module: z.string().optional(),
    call_function: z.string().optional(),
    call_hash: z.string().optional(),
    success: z.boolean().optional(),
    block_start: z.int().min(0).optional(),
    block_end: z.int().min(0).optional(),
    from: z.int().min(0).optional(),
    to: z.int().min(0).optional(),
    limit: z.int().min(1).max(100).optional(),
    offset: z.int().min(0).optional(),
    cursor: z.string().optional(),
  })
  .strict();
export type ListExtrinsicsInput = z.infer<typeof ListExtrinsicsInputSchema>;

export const ListExtrinsicsOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    extrinsic_count: z.int(),
    limit: z.int().nullable().optional(),
    offset: z.int().nullable().optional(),
    next_cursor: z.string().nullable().optional(),
    extrinsics: z.array(ExtrinsicItemSchema),
  })
  .passthrough();
export type ListExtrinsicsOutput = z.infer<typeof ListExtrinsicsOutputSchema>;

export const GetExtrinsicInputSchema = z
  .object({
    ref: z.string(),
  })
  .strict();
export type GetExtrinsicInput = z.infer<typeof GetExtrinsicInputSchema>;

export const GetExtrinsicOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    ref: z.unknown(),
    extrinsic: OpenObjectSchema.nullable().optional(),
    events: z.array(AccountEventItemSchema).optional(),
  })
  .passthrough();
export type GetExtrinsicOutput = z.infer<typeof GetExtrinsicOutputSchema>;
