// MCP tools `get_subnet_hyperparams`, `get_subnet_hyperparams_history`
// (types-epic E batch 4, #8067). Mirror GET /api/v1/subnets/{netuid}/
// hyperparameters(/history), neither of which is one of schemas-src/routes/'s
// covered pilot routes -- no existing Zod schema to reuse. Modeled fresh,
// shallow, from the hand-written literals they replace.
import { z } from "zod";
import {
  OpenObjectSchema,
  keysetCursorSchema,
  limitSchema,
  netuidSchema,
  offsetSchema,
} from "./shared.ts";

export const GetSubnetHyperparamsInputSchema = z
  .object({
    netuid: netuidSchema(),
  })
  .strict();
export type GetSubnetHyperparamsInput = z.infer<
  typeof GetSubnetHyperparamsInputSchema
>;

export const GetSubnetHyperparamsOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    netuid: netuidSchema(),
    captured_at: z.string().nullable().optional(),
    block_number: z.int().nullable().optional(),
    hyperparameters: OpenObjectSchema.nullable().optional(),
  })
  .passthrough();
export type GetSubnetHyperparamsOutput = z.infer<
  typeof GetSubnetHyperparamsOutputSchema
>;

export const GetSubnetHyperparamsHistoryInputSchema = z
  .object({
    netuid: netuidSchema(),
    limit: limitSchema(1000).optional(),
    offset: offsetSchema().optional(),
    cursor: keysetCursorSchema().optional(),
  })
  .strict();
export type GetSubnetHyperparamsHistoryInput = z.infer<
  typeof GetSubnetHyperparamsHistoryInputSchema
>;

// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note from the pilot batch).
const HyperparamsHistoryEntrySchema = z
  .object({
    block_number: z.int().nullable().optional(),
    observed_at: z.string().nullable().optional(),
    hyperparameters: OpenObjectSchema.nullable().optional(),
    hyperparams_hash: z.string().nullable().optional(),
  })
  .passthrough();

export const GetSubnetHyperparamsHistoryOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    netuid: netuidSchema(),
    entry_count: z.int(),
    limit: z.int().nullable().optional(),
    offset: z.int().nullable().optional(),
    next_cursor: z.string().nullable().optional(),
    entries: z.array(HyperparamsHistoryEntrySchema),
  })
  .passthrough();
export type GetSubnetHyperparamsHistoryOutput = z.infer<
  typeof GetSubnetHyperparamsHistoryOutputSchema
>;
