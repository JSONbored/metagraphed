// MCP tool `get_subnet_concentration` (types-epic E batch 2, #8065). Mirrors
// GET /api/v1/subnets/{netuid}/concentration, which is not one of
// schemas-src/routes/'s covered pilot routes -- no existing Zod schema to
// reuse. Modeled fresh, shallow, from the hand-written literal it replaces.
import { z } from "zod";
import { OpenObjectSchema } from "./shared.ts";

export const GetSubnetConcentrationInputSchema = z
  .object({
    netuid: z.int().min(0),
  })
  .strict();
export type GetSubnetConcentrationInput = z.infer<
  typeof GetSubnetConcentrationInputSchema
>;

export const GetSubnetConcentrationOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    netuid: z.int(),
    neuron_count: z.int(),
    entity_count: z.int().optional(),
    uids_per_entity: z.number().nullable().optional(),
    captured_at: z.string().nullable().optional(),
    stake: OpenObjectSchema.nullable().optional(),
    emission: OpenObjectSchema.nullable().optional(),
    entity_stake: OpenObjectSchema.nullable().optional(),
    entity_emission: OpenObjectSchema.nullable().optional(),
    validator_stake: OpenObjectSchema.nullable().optional(),
  })
  .passthrough();
export type GetSubnetConcentrationOutput = z.infer<
  typeof GetSubnetConcentrationOutputSchema
>;
