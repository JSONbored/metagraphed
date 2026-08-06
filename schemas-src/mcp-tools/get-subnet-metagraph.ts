// MCP tool `get_subnet_metagraph` (types-epic E batch 4, #8067). Mirrors
// GET /api/v1/subnets/{netuid}/metagraph, which is not one of
// schemas-src/routes/'s covered pilot routes -- no existing Zod schema to
// reuse. Modeled fresh, shallow, from the hand-written literal it replaces.
import { z } from "zod";
import {
  NeuronFieldsInputSchema,
  OpenObjectArraySchema,
  netuidSchema,
} from "./shared.ts";

export const GetSubnetMetagraphInputSchema = z
  .object({
    netuid: netuidSchema(),
    validator_permit: z
      .boolean()
      .optional()
      .describe(
        "Restrict to neurons that hold (`true`) or lack (`false`) a validator permit.",
      )
      .meta({ examples: [true] }),
    // #9082: narrow each returned row to these fields. Omit for the full
    // row. Valid names are NeuronSchema's own, so this enum cannot drift
    // from what the route can project.
    fields: NeuronFieldsInputSchema.meta({ examples: ["netuid,name,slug"] }),
  })
  .strict();
export type GetSubnetMetagraphInput = z.infer<
  typeof GetSubnetMetagraphInputSchema
>;

export const GetSubnetMetagraphOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    netuid: netuidSchema(),
    neuron_count: z.int(),
    captured_at: z.string().nullable().optional(),
    block_number: z.int().nullable().optional(),
    neurons: OpenObjectArraySchema,
  })
  .passthrough();
export type GetSubnetMetagraphOutput = z.infer<
  typeof GetSubnetMetagraphOutputSchema
>;
