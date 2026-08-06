// MCP tool `get_subnet_health_trends` (types-epic E batch 2, #8065). Mirrors
// GET /api/v1/subnets/{netuid}/health/trends, which is not one of
// schemas-src/routes/'s covered pilot routes -- no existing Zod schema to
// reuse. Modeled fresh, shallow, from the hand-written literal it replaces.
import { z } from "zod";
import { OpenObjectSchema, netuidSchema } from "./shared.ts";

export const GetSubnetHealthTrendsInputSchema = z
  .object({
    netuid: netuidSchema(),
  })
  .strict();
export type GetSubnetHealthTrendsInput = z.infer<
  typeof GetSubnetHealthTrendsInputSchema
>;

export const GetSubnetHealthTrendsOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    netuid: netuidSchema(),
    observed_at: z.string().nullable().optional(),
    source: z.string().nullable().optional(),
    windows: OpenObjectSchema,
  })
  .passthrough();
export type GetSubnetHealthTrendsOutput = z.infer<
  typeof GetSubnetHealthTrendsOutputSchema
>;
