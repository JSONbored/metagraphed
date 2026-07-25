// MCP tool `get_blocks_summary` (types-epic E batch 3, #8066). Mirrors GET
// /api/v1/blocks/summary, which is not one of schemas-src/routes/'s covered
// pilot routes -- no existing Zod schema to reuse. Modeled fresh, shallow,
// from the hand-written literal it replaces.
import { z } from "zod";
import { OpenObjectSchema } from "./shared.ts";

export const GetBlocksSummaryInputSchema = z.object({}).strict();
export type GetBlocksSummaryInput = z.infer<typeof GetBlocksSummaryInputSchema>;

export const GetBlocksSummaryOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    block_count: z.int(),
    first_block: z.int().nullable().optional(),
    last_block: z.int().nullable().optional(),
    first_observed_at: z.string().nullable().optional(),
    last_observed_at: z.string().nullable().optional(),
    block_time: OpenObjectSchema.nullable().optional(),
    throughput: OpenObjectSchema.nullable().optional(),
    distinct_authors: z.int().optional(),
    author_concentration: OpenObjectSchema.nullable().optional(),
    distinct_spec_versions: z.int().optional(),
    latest_spec_version: z.int().nullable().optional(),
  })
  .passthrough();
export type GetBlocksSummaryOutput = z.infer<
  typeof GetBlocksSummaryOutputSchema
>;
