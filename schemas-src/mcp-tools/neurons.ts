// MCP tools `get_neuron`, `get_neuron_history` (types-epic E batch 4,
// #8068). Each mirrors a GET /api/v1/subnets/{netuid}/neurons* route that is
// not one of schemas-src/routes/'s covered pilot routes -- no existing Zod
// schema to reuse. Modeled fresh, matching each hand-written literal
// field-for-field.
import { z } from "zod";
import {
  NeuronFieldsInputSchema,
  OpenObjectArraySchema,
  OpenObjectSchema,
  netuidSchema,
  uidSchema,
  windowSchema,
} from "./shared.ts";

export const GetNeuronInputSchema = z
  .object({
    netuid: netuidSchema(),
    uid: uidSchema(),
    // #9082: narrow each returned row to these fields. Omit for the full
    // row. Valid names are NeuronSchema's own, so this enum cannot drift
    // from what the route can project.
    fields: NeuronFieldsInputSchema.meta({ examples: ["netuid,name,slug"] }),
  })
  .strict();
export type GetNeuronInput = z.infer<typeof GetNeuronInputSchema>;

export const GetNeuronOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    netuid: netuidSchema(),
    captured_at: z.string().nullable().optional(),
    block_number: z.int().nullable().optional(),
    neuron: OpenObjectSchema.nullable(),
  })
  .passthrough();
export type GetNeuronOutput = z.infer<typeof GetNeuronOutputSchema>;

export const GetNeuronHistoryInputSchema = z
  .object({
    netuid: netuidSchema(),
    uid: uidSchema(),
    window: windowSchema(["7d", "30d", "90d", "1y", "all"]).optional(),
  })
  .strict();
export type GetNeuronHistoryInput = z.infer<typeof GetNeuronHistoryInputSchema>;

export const GetNeuronHistoryOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    netuid: netuidSchema(),
    uid: z.int(),
    window: z.string().nullable().optional(),
    point_count: z.int(),
    points: OpenObjectArraySchema,
  })
  .passthrough();
export type GetNeuronHistoryOutput = z.infer<
  typeof GetNeuronHistoryOutputSchema
>;
