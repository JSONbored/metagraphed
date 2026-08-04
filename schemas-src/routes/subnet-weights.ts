// GET /api/v1/subnets/{netuid}/weights + .../weights/setters (types-epic B
// batch 3, #8057). Live account_events WeightsSet-stream data -- no static
// file. Modeled from src/subnet-weights.ts / src/subnet-weight-setters.ts,
// cross-checked against the hand-edited SubnetWeightsArtifact/
// SubnetWeightSettersArtifact components they replace, and against live
// get_subnet_weights/get_subnet_weight_setters responses for subnet 1
// (confirmed every setter row's `hotkey` reads back null in practice --
// matches the hand-edited component's declared nullability).
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";

export const SubnetWeightsArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    window: z.enum(["7d", "30d"]).nullable(),
    observed_at: z.string().nullable(),
    distinct_setters: z.int().min(0),
    weight_sets: z.int().min(0),
    sets_per_setter: z.number().min(0).nullable(),
  })
  .strict();
export type SubnetWeightsArtifact = z.infer<typeof SubnetWeightsArtifactSchema>;
export const SubnetWeightsResponseSchema = successEnvelopeSchema(
  SubnetWeightsArtifactSchema,
);
export const SubnetWeightsQuerySchema = z
  .object({
    window: z.enum(["7d", "30d"]).optional(),
  })
  .strict();
export type SubnetWeightsQuery = z.infer<typeof SubnetWeightsQuerySchema>;

const SubnetWeightSetterSchema = z
  .object({
    hotkey: z.string().nullable(),
    uid: z.int().min(0).nullable(),
    weight_sets: z.int().min(0),
    share: z.number().min(0).nullable(),
    first_set_at: z.string().nullable(),
    last_set_at: z.string().nullable(),
    // #9389. Measured against the window's newest event rather than wall-clock now, so
    // the payload is internally consistent and a stale read reports the lag it actually
    // observed rather than one inflated by how long ago the tier answered.
    seconds_since_last_set: z.int().min(0).nullable(),
    tempos_since_last_set: z.number().min(0).nullable(),
    overdue: z
      .boolean()
      .nullable()
      .describe(
        "Whether this setter is more than overdue_tempo_multiple tempos past its last weight set. NULL means not evaluated -- the subnet's tempo or this setter's last_set_at was unavailable -- which is deliberately distinct from false ('evaluated, on time').",
      ),
  })
  .strict();

export const SubnetWeightSettersArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    window: z.enum(["7d", "30d"]).nullable(),
    observed_at: z.string().nullable(),
    distinct_setters: z.int().min(0),
    weight_sets: z.int().min(0),
    setter_count: z.int().min(0),
    // The cadence the verdicts were measured against, echoed so a null `overdue` is
    // explainable from the payload alone. Null when the subnet has no hyperparams row.
    tempo: z.int().min(0).nullable(),
    overdue_tempo_multiple: z.int().min(0),
    overdue_setter_count: z.int().min(0),
    setters: z.array(SubnetWeightSetterSchema),
  })
  .strict();
export type SubnetWeightSettersArtifact = z.infer<
  typeof SubnetWeightSettersArtifactSchema
>;
export const SubnetWeightSettersResponseSchema = successEnvelopeSchema(
  SubnetWeightSettersArtifactSchema,
);
export const SubnetWeightSettersQuerySchema = z
  .object({
    window: z.enum(["7d", "30d"]).optional(),
  })
  .strict();
export type SubnetWeightSettersQuery = z.infer<
  typeof SubnetWeightSettersQuerySchema
>;
