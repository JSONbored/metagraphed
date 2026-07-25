// MCP tool `compare_subnets` (types-epic E batch 4, #8067). Mirrors GET
// /api/v1/compare, which is not one of schemas-src/routes/'s covered pilot
// routes -- no existing Zod schema to reuse. Modeled fresh, shallow, from
// the hand-written literal it replaces.
import { z } from "zod";
import { OpenObjectArraySchema } from "./shared.ts";

const COMPARE_DIMENSIONS = ["structure", "economics", "health"] as const;

export const CompareSubnetsInputSchema = z
  .object({
    netuids: z.array(z.int().min(0)).min(1).max(128),
    dimensions: z.array(z.enum(COMPARE_DIMENSIONS)).optional(),
  })
  .strict();
export type CompareSubnetsInput = z.infer<typeof CompareSubnetsInputSchema>;

export const CompareSubnetsOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    requested_netuids: z.array(z.int()),
    dimensions: z.array(z.string()),
    subnets: OpenObjectArraySchema,
    observed_at: z.string().nullable().optional(),
  })
  .passthrough();
export type CompareSubnetsOutput = z.infer<typeof CompareSubnetsOutputSchema>;
