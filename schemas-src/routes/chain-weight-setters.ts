// GET /api/v1/chain/weights/setters (types-epic B batch 6, #8060). Live
// account_events WeightsSet-stream data -- no static file. Modeled from
// src/chain-weight-setters.ts's buildChainWeightSetters(), cross-checked
// against the hand-edited ChainWeightSettersArtifact component it replaces.
// Unlike the network-rollup family in chain-network-rollups.ts, this route
// is a flat individual-validator leaderboard (no per-subnet breakdown, no
// intensity distribution) -- each setter row carries an optional `netuid`
// scoping a uid-only setter, null when a network-wide hotkey identifies it.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";

const ChainWeightSetterSchema = z
  .object({
    hotkey: z.string().nullable(),
    netuid: z.int().min(0).nullable(),
    uid: z.int().min(0).nullable(),
    weight_sets: z.int().min(0),
    share: z.number().min(0).nullable(),
    first_set_at: z.string().nullable(),
    last_set_at: z.string().nullable(),
  })
  .strict();

export const ChainWeightSettersArtifactSchema = z
  .object({
    schema_version: z.int(),
    window: z.enum(["7d", "30d"]).nullable(),
    observed_at: z.string().nullable(),
    distinct_setters: z.int().min(0),
    weight_sets: z.int().min(0),
    setter_count: z.int().min(0),
    setters: z.array(ChainWeightSetterSchema),
  })
  .strict();
export type ChainWeightSettersArtifact = z.infer<
  typeof ChainWeightSettersArtifactSchema
>;
export const ChainWeightSettersResponseSchema = successEnvelopeSchema(
  ChainWeightSettersArtifactSchema,
);
export const ChainWeightSettersQuerySchema = z
  .object({
    window: z.enum(["7d", "30d"]).optional(),
    limit: z.int().min(1).optional(),
    format: z.enum(["json", "csv"]).optional(),
  })
  .strict();
export type ChainWeightSettersQuery = z.infer<
  typeof ChainWeightSettersQuerySchema
>;
