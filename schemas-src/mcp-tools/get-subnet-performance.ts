// MCP tool `get_subnet_performance` (types-epic E batch 2, #8065). Mirrors
// GET /api/v1/subnets/{netuid}/performance, which is not one of
// schemas-src/routes/'s covered pilot routes -- no existing Zod schema to
// reuse. Modeled fresh, shallow, from the hand-written literal it replaces.
import { z } from "zod";
import { OpenObjectSchema } from "./shared.ts";

export const GetSubnetPerformanceInputSchema = z
  .object({
    netuid: z.int().min(0),
  })
  .strict();
export type GetSubnetPerformanceInput = z.infer<
  typeof GetSubnetPerformanceInputSchema
>;

export const GetSubnetPerformanceOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    netuid: z.int(),
    neuron_count: z.int(),
    validator_count: z.int().optional(),
    active_count: z.int().optional(),
    captured_at: z.string().nullable().optional(),
    incentive: OpenObjectSchema.nullable().optional(),
    dividends: OpenObjectSchema.nullable().optional(),
    trust: OpenObjectSchema.nullable().optional(),
    consensus: OpenObjectSchema.nullable().optional(),
    validator_trust: OpenObjectSchema.nullable().optional(),
  })
  .passthrough();
export type GetSubnetPerformanceOutput = z.infer<
  typeof GetSubnetPerformanceOutputSchema
>;
