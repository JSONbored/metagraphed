// GET /api/v1/subnets/{netuid}/history (types-epic B batch 1, #8055). Live
// neuron_daily-tier daily sparkline -- no static file. Modeled from
// src/neuron-history.ts's buildSubnetHistory(), cross-checked against the
// hand-edited SubnetHistoryArtifact component it replaces. `window` stays
// a bare nullable string (no enum) matching the original exactly: although
// parseHistoryWindow() always resolves a concrete label from
// HISTORY_WINDOWS ("7d"/"30d"/"90d"/"1y"/"all") before this is built, adding
// an enum here would be a real (if inert) tightening the issue's wire-
// compatibility constraint doesn't require -- left loose on purpose.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";

const SubnetHistoryPointSchema = z
  .object({
    snapshot_date: z.string(),
    neuron_count: z.int().nullable().optional(),
    validator_count: z.int().nullable().optional(),
    total_stake_tao: z.number().nullable().optional(),
    total_emission_tao: z.number().nullable().optional(),
  })
  .strict();

export const SubnetHistoryArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    window: z.string().nullable().optional(),
    point_count: z.int().min(0),
    points: z.array(SubnetHistoryPointSchema),
  })
  .passthrough();
export type SubnetHistoryArtifact = z.infer<typeof SubnetHistoryArtifactSchema>;
export const SubnetHistoryResponseSchema = successEnvelopeSchema(
  SubnetHistoryArtifactSchema,
);

export const SubnetHistoryQuerySchema = z
  .object({
    window: z.enum(["7d", "30d", "90d", "1y", "all"]).optional(),
  })
  .strict();
export type SubnetHistoryQuery = z.infer<typeof SubnetHistoryQuerySchema>;
