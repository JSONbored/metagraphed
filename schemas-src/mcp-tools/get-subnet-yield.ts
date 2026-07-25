// MCP tool `get_subnet_yield` (types-epic E batch 3, #8066). Mirrors GET
// /api/v1/subnets/{netuid}/yield, which is not one of schemas-src/routes/'s
// covered pilot routes -- no existing Zod schema to reuse. Modeled fresh,
// shallow, from the hand-written literal it replaces.
import { z } from "zod";
import { OpenObjectArraySchema } from "./shared.ts";

export const GetSubnetYieldInputSchema = z
  .object({
    netuid: z.int().min(0),
  })
  .strict();
export type GetSubnetYieldInput = z.infer<typeof GetSubnetYieldInputSchema>;

export const GetSubnetYieldOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    netuid: z.int(),
    captured_at: z.string().nullable().optional(),
    block_number: z.int().nullable().optional(),
    neuron_count: z.int(),
    validator_count: z.int().optional(),
    miner_count: z.int().optional(),
    total_stake_tao: z.number().nullable().optional(),
    total_emission_tao: z.number().nullable().optional(),
    subnet_yield: z.number().nullable().optional(),
    mean_yield: z.number().nullable().optional(),
    median_yield: z.number().nullable().optional(),
    p25_yield: z.number().nullable().optional(),
    p75_yield: z.number().nullable().optional(),
    p90_yield: z.number().nullable().optional(),
    neurons: OpenObjectArraySchema,
  })
  .passthrough();
export type GetSubnetYieldOutput = z.infer<typeof GetSubnetYieldOutputSchema>;
