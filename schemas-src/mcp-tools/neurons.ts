// MCP tools `get_neuron`, `get_neuron_history` (types-epic E batch 4,
// #8068). Each mirrors a GET /api/v1/subnets/{netuid}/neurons* route that is
// not one of schemas-src/routes/'s covered pilot routes -- no existing Zod
// schema to reuse. Modeled fresh, matching each hand-written literal
// field-for-field.
import { z } from "zod";
import { OpenObjectArraySchema, OpenObjectSchema } from "./shared.ts";

export const GetNeuronInputSchema = z
  .object({
    netuid: z.int().min(0),
    uid: z.int().min(0),
    /** #9082: narrow each returned neuron row to these fields. The rows are
     * 17+ fields wide and a full subnet is ~24k tokens; "is my miner
     * registered" needs two of them. Applied after the tier returns, like
     * this family's other MCP-only post-filters. Field names come from the
     * published neuron schema; an unknown one is an invalid_params error
     * rather than a silent no-op. */
    fields: z.array(z.string()).min(1).optional(),
  })
  .strict();
export type GetNeuronInput = z.infer<typeof GetNeuronInputSchema>;

export const GetNeuronOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    netuid: z.int(),
    captured_at: z.string().nullable().optional(),
    block_number: z.int().nullable().optional(),
    neuron: OpenObjectSchema.nullable(),
  })
  .passthrough();
export type GetNeuronOutput = z.infer<typeof GetNeuronOutputSchema>;

export const GetNeuronHistoryInputSchema = z
  .object({
    netuid: z.int().min(0),
    uid: z.int().min(0),
    window: z.enum(["7d", "30d", "90d", "1y", "all"]).optional(),
  })
  .strict();
export type GetNeuronHistoryInput = z.infer<typeof GetNeuronHistoryInputSchema>;

export const GetNeuronHistoryOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    netuid: z.int(),
    uid: z.int(),
    window: z.string().nullable().optional(),
    point_count: z.int(),
    points: OpenObjectArraySchema,
  })
  .passthrough();
export type GetNeuronHistoryOutput = z.infer<
  typeof GetNeuronHistoryOutputSchema
>;
