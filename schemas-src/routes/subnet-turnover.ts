// GET /api/v1/subnets/{netuid}/turnover (types-epic B batch 2, #8056). Live
// neuron_daily-tier boundary-snapshot diff -- no static file. Modeled from
// src/turnover.ts's buildTurnover()/buildTurnoverChanges(), cross-checked
// against the hand-edited SubnetTurnoverArtifact component it replaces.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";

const ValidatorDetailSchema = z
  .object({
    hotkey: z.string(),
    uid: z.int().nullable(),
  })
  .strict();

const UidReassignmentSchema = z
  .object({
    uid: z.int().min(0),
    from_hotkey: z.string(),
    to_hotkey: z.string(),
  })
  .strict();

const TurnoverChangesSchema = z
  .object({
    validators_entered_count: z.int().min(0).optional(),
    validators_exited_count: z.int().min(0).optional(),
    uid_reassignment_count: z.int().min(0).optional(),
    validators_entered: z.array(ValidatorDetailSchema),
    validators_exited: z.array(ValidatorDetailSchema),
    uid_reassignments: z.array(UidReassignmentSchema),
  })
  .strict();

export const SubnetTurnoverArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    window: z.string().nullable().optional(),
    start_date: z.string().nullable().optional(),
    end_date: z.string().nullable().optional(),
    comparable: z.boolean(),
    validators_start: z.int().min(0).optional(),
    validators_end: z.int().min(0).optional(),
    validators_entered: z.int().min(0).optional(),
    validators_exited: z.int().min(0).optional(),
    validator_retention: z.number().nullable().optional(),
    neurons_start: z.int().min(0).optional(),
    neurons_end: z.int().min(0).optional(),
    uids_deregistered: z.int().min(0).optional(),
    neuron_retention: z.number().nullable().optional(),
    stability_score: z.int().nullable().optional(),
    changes: TurnoverChangesSchema.nullable().optional(),
  })
  .passthrough();
export type SubnetTurnoverArtifact = z.infer<
  typeof SubnetTurnoverArtifactSchema
>;
export const SubnetTurnoverResponseSchema = successEnvelopeSchema(
  SubnetTurnoverArtifactSchema,
);

export const SubnetTurnoverQuerySchema = z
  .object({
    window: z.enum(["7d", "30d", "90d", "1y", "all"]).optional(),
    changes: z.enum(["true"]).optional(),
  })
  .strict();
export type SubnetTurnoverQuery = z.infer<typeof SubnetTurnoverQuerySchema>;
