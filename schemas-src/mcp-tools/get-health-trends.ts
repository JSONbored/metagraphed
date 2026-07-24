// MCP tool `get_health_trends` (types-epic E batch 2, #8065). Mirrors GET
// /api/v1/health/trends, which is not one of schemas-src/routes/'s covered
// pilot routes -- no existing Zod schema to reuse. Modeled fresh, shallow,
// from the hand-written literal it replaces.
import { z } from "zod";
import { OpenObjectSchema } from "./shared.ts";

export const GetHealthTrendsInputSchema = z.object({}).strict();
export type GetHealthTrendsInput = z.infer<typeof GetHealthTrendsInputSchema>;

export const GetHealthTrendsOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    observed_at: z.string().nullable().optional(),
    source: z.string().nullable().optional(),
    windows: OpenObjectSchema,
  })
  .passthrough();
export type GetHealthTrendsOutput = z.infer<typeof GetHealthTrendsOutputSchema>;
