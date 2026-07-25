// MCP tool `get_subnet_weights` (types-epic E batch 3, #8066). Mirrors GET
// /api/v1/subnets/{netuid}/weights, which is not one of schemas-src/routes/'s
// covered pilot routes -- no existing Zod schema to reuse. Modeled fresh,
// shallow, from the hand-written literal it replaces.
import { z } from "zod";

const SUBNET_WEIGHTS_WINDOWS = ["7d", "30d"] as const;

export const GetSubnetWeightsInputSchema = z
  .object({
    netuid: z.int().min(0),
    window: z.enum(SUBNET_WEIGHTS_WINDOWS).optional(),
  })
  .strict();
export type GetSubnetWeightsInput = z.infer<typeof GetSubnetWeightsInputSchema>;

export const GetSubnetWeightsOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    netuid: z.int(),
    window: z.string().nullable(),
    observed_at: z.string().nullable().optional(),
    distinct_setters: z.int(),
    weight_sets: z.int(),
    sets_per_setter: z.number().nullable(),
  })
  .passthrough();
export type GetSubnetWeightsOutput = z.infer<
  typeof GetSubnetWeightsOutputSchema
>;
