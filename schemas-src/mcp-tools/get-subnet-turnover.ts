// MCP tool `get_subnet_turnover` (types-epic E batch 3, #8066). Mirrors GET
// /api/v1/subnets/{netuid}/turnover, which is not one of schemas-src/routes/'s
// covered pilot routes -- no existing Zod schema to reuse. Modeled fresh,
// shallow, from the hand-written literal it replaces. Window enum
// hardcoded from src/neuron-history.ts's HISTORY_WINDOWS at the time of
// writing (mirrors the pilot batch's ECONOMICS_SORT_FIELDS precedent -- not
// cross-imported).
import { z } from "zod";
import { OpenObjectArraySchema } from "./shared.ts";

const HISTORY_WINDOWS = ["7d", "30d", "90d", "1y", "all"] as const;

export const GetSubnetTurnoverInputSchema = z
  .object({
    netuid: z.int().min(0),
    window: z.enum(HISTORY_WINDOWS).optional(),
    changes: z.boolean().optional(),
  })
  .strict();
export type GetSubnetTurnoverInput = z.infer<
  typeof GetSubnetTurnoverInputSchema
>;

const TurnoverChangesSchema = z
  .object({
    validators_entered_count: z.int().optional(),
    validators_exited_count: z.int().optional(),
    uid_reassignment_count: z.int().optional(),
    validators_entered: OpenObjectArraySchema.optional(),
    validators_exited: OpenObjectArraySchema.optional(),
    uid_reassignments: OpenObjectArraySchema.optional(),
  })
  .passthrough();

export const GetSubnetTurnoverOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    netuid: z.int(),
    window: z.string().nullable().optional(),
    start_date: z.string().nullable().optional(),
    end_date: z.string().nullable().optional(),
    comparable: z.boolean(),
    validators_start: z.int(),
    validators_end: z.int(),
    validators_entered: z.int(),
    validators_exited: z.int(),
    validator_retention: z.number().nullable().optional(),
    neurons_start: z.int(),
    neurons_end: z.int(),
    uids_deregistered: z.int(),
    neuron_retention: z.number().nullable().optional(),
    stability_score: z.int().nullable().optional(),
    changes: TurnoverChangesSchema.optional(),
  })
  .passthrough();
export type GetSubnetTurnoverOutput = z.infer<
  typeof GetSubnetTurnoverOutputSchema
>;
