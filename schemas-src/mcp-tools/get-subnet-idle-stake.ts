// MCP tool `get_subnet_idle_stake` (types-epic E batch 2, #8065). Mirrors
// GET /api/v1/subnets/{netuid}/idle-stake, which is not one of
// schemas-src/routes/'s covered pilot routes -- no existing Zod schema to
// reuse. Modeled fresh, shallow, from the hand-written literal it replaces.
import { z } from "zod";
import { netuidSchema } from "./shared.ts";

export const GetSubnetIdleStakeInputSchema = z
  .object({
    netuid: netuidSchema(),
  })
  .strict();
export type GetSubnetIdleStakeInput = z.infer<
  typeof GetSubnetIdleStakeInputSchema
>;

export const GetSubnetIdleStakeOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    netuid: netuidSchema(),
    captured_at: z.string().nullable().optional(),
    neuron_count: z.int(),
    idle_neuron_count: z.int(),
    idle_stake_alpha: z.number(),
  })
  .passthrough();
export type GetSubnetIdleStakeOutput = z.infer<
  typeof GetSubnetIdleStakeOutputSchema
>;
