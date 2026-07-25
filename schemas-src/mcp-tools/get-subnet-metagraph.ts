// MCP tool `get_subnet_metagraph` (types-epic E batch 4, #8067). Mirrors
// GET /api/v1/subnets/{netuid}/metagraph, which is not one of
// schemas-src/routes/'s covered pilot routes -- no existing Zod schema to
// reuse. Modeled fresh, shallow, from the hand-written literal it replaces.
import { z } from "zod";
import { OpenObjectArraySchema } from "./shared.ts";

export const GetSubnetMetagraphInputSchema = z
  .object({
    netuid: z.int().min(0),
    validator_permit: z.boolean().optional(),
  })
  .strict();
export type GetSubnetMetagraphInput = z.infer<
  typeof GetSubnetMetagraphInputSchema
>;

export const GetSubnetMetagraphOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    netuid: z.int(),
    neuron_count: z.int(),
    captured_at: z.string().nullable().optional(),
    block_number: z.int().nullable().optional(),
    neurons: OpenObjectArraySchema,
  })
  .passthrough();
export type GetSubnetMetagraphOutput = z.infer<
  typeof GetSubnetMetagraphOutputSchema
>;
