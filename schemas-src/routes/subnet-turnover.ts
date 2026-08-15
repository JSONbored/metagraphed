// GET /api/v1/subnets/{netuid}/turnover (types-epic B batch 2, #8056). Live
// neuron_daily-tier boundary-snapshot diff -- no static file. Modeled from
// src/turnover.ts's buildTurnover()/buildTurnoverChanges(), cross-checked
// against the hand-edited SubnetTurnoverArtifact component it replaces.
import { z } from "zod";

/** This route's own vocabulary, owned here so its MCP tool imports rather than restates it (#9799). */
export const SUBNET_TURNOVER_WINDOW_VALUES = [
  "7d",
  "30d",
  "90d",
  "1y",
  "all",
] as const;

const ValidatorDetailSchema = z
  .object({
    hotkey: z.string(),
    uid: z
      .int()
      .nullable()
      .describe(
        "The UID it held at the boundary snapshot, null when the row carried no usable uid.",
      ),
  })
  .strict()
  .describe(
    "One validator that entered or left a subnet's validator set between the window's boundary snapshots.",
  );

const UidReassignmentSchema = z
  .object({
    uid: z.int().min(0),
    from_hotkey: z.string(),
    to_hotkey: z.string(),
  })
  .strict()
  .describe(
    "One UID that changed hands between the window's boundary snapshots.",
  );

const TurnoverChangesSchema = z
  .object({
    validators_entered_count: z.int().min(0).optional(),
    validators_exited_count: z.int().min(0).optional(),
    uid_reassignment_count: z.int().min(0).optional(),
    validators_entered: z.array(ValidatorDetailSchema),
    validators_exited: z.array(ValidatorDetailSchema),
    uid_reassignments: z.array(UidReassignmentSchema),
  })
  .strict()
  .describe(
    "The per-neuron churn behind a subnet's turnover scorecard: which validators entered and exited, and which UIDs were reassigned. Mirrors the changes block of GET /api/v1/subnets/{netuid}/turnover?changes=true.",
  );

export const SubnetTurnoverArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    window: z.string().nullable().optional(),
    start_date: z.string().nullable().optional(),
    end_date: z.string().nullable().optional(),
    covered_days: z
      .int()
      .min(0)
      .nullable()
      .optional()
      .describe(
        "Days actually compared -- end_date minus start_date. Read THIS, not `window`, when stating the period: neuron_daily is shallower than the widest windows, so the store's floor clamps them. Measured 2026-08-15, ?window=90d, 1y and all all returned the same 36-day comparison (#10798).",
      ),
    requested_days: z
      .int()
      .min(0)
      .nullable()
      .optional()
      .describe(
        "The window's declared day count, or NULL for `all`, which asks for whatever exists rather than a fixed span.",
      ),
    window_truncated: z
      .boolean()
      .nullable()
      .optional()
      .describe(
        "True when covered_days is short of requested_days because the store does not reach back that far. It matters in ONE direction: turnover compares the window's endpoints, so a shortened span reports LOWER churn and HIGHER stability -- a subnet that replaced its whole validator set over a year reads as a calm month. NULL when the bounds could not be resolved at all, never false, which would assert a window nobody measured was complete.",
      ),
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
    changes: TurnoverChangesSchema.nullable()
      .optional()
      .describe(
        "Per-neuron churn detail behind the counts above, populated only when the field's changes toggle is set (mirroring REST's ?changes=true). Null otherwise, and on a cold store.",
      ),
  })
  .strict()
  .describe(
    "One subnet's validator/neuron-set turnover between a window's boundary snapshots. The churn metrics are zeroed and the retentions/stability null on a single-snapshot or cold store (schema-stable). Mirrors GET /api/v1/subnets/{netuid}/turnover's default scorecard.",
  );
export type SubnetTurnoverArtifact = z.infer<
  typeof SubnetTurnoverArtifactSchema
>;
