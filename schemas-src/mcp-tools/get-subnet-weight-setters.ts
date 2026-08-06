// MCP tool `get_subnet_weight_setters` (types-epic E batch 3, #8066).
// Mirrors GET /api/v1/subnets/{netuid}/weights/setters, which is not one of
// schemas-src/routes/'s covered pilot routes -- no existing Zod schema to
// reuse. Modeled fresh, shallow, from the hand-written literal it replaces.
import { z } from "zod";
import { netuidSchema, windowSchema } from "./shared.ts";

const SUBNET_WEIGHT_SETTERS_WINDOWS = ["7d", "30d"] as const;

export const GetSubnetWeightSettersInputSchema = z
  .object({
    netuid: netuidSchema(),
    window: windowSchema(SUBNET_WEIGHT_SETTERS_WINDOWS).optional(),
  })
  .strict();
export type GetSubnetWeightSettersInput = z.infer<
  typeof GetSubnetWeightSettersInputSchema
>;

// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note from the pilot batch).
const WeightSetterSchema = z
  .object({
    hotkey: z.string().nullable().optional(),
    uid: z.int().nullable().optional(),
    weight_sets: z.int().optional(),
    share: z.unknown().optional(),
    first_set_at: z.string().nullable().optional(),
    last_set_at: z.string().nullable().optional(),
    // #9389: null `overdue` means NOT EVALUATED, not "on time".
    seconds_since_last_set: z.int().nullable().optional(),
    tempos_since_last_set: z.number().nullable().optional(),
    overdue: z.boolean().nullable().optional(),
  })
  .passthrough();

export const GetSubnetWeightSettersOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    netuid: netuidSchema(),
    window: z.string().nullable(),
    observed_at: z.string().nullable().optional(),
    distinct_setters: z.int(),
    weight_sets: z.int(),
    setter_count: z.int(),
    tempo: z.int().nullable().optional(),
    overdue_tempo_multiple: z.int().optional(),
    overdue_setter_count: z.int().optional(),
    setters: z.array(WeightSetterSchema),
  })
  .passthrough();
export type GetSubnetWeightSettersOutput = z.infer<
  typeof GetSubnetWeightSettersOutputSchema
>;
