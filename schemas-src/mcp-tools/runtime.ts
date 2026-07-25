// MCP tool `get_runtime` (types-epic E batch 8, #8071). Mirrors
// GET /api/v1/runtime, which is not one of schemas-src/routes/'s covered
// pilot routes -- no existing Zod schema to reuse. Modeled fresh, matching
// the hand-written literal it replaces field-for-field.
import { z } from "zod";

export const GetRuntimeInputSchema = z.object({}).strict();
export type GetRuntimeInput = z.infer<typeof GetRuntimeInputSchema>;

// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note from the pilot batch) -- but unlike most
// other item shapes in this epic, spec_version/block_number are plain
// (non-nullable) integers when present: the hand-written original wraps
// them in bare `{type:"integer"}`, not NULLABLE_INT.
const RuntimeTransitionSchema = z
  .object({
    spec_version: z.int().optional(),
    block_number: z.int().optional(),
    observed_at: z.string().nullable().optional(),
  })
  .passthrough();

export const GetRuntimeOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    transition_count: z.int(),
    current_spec_version: z.int().nullable().optional(),
    coverage_from_block: z.int().nullable().optional(),
    coverage_from_at: z.string().nullable().optional(),
    transitions: z.array(RuntimeTransitionSchema),
  })
  .passthrough();
export type GetRuntimeOutput = z.infer<typeof GetRuntimeOutputSchema>;
