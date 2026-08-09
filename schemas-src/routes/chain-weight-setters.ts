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
    share: z
      .number()
      .min(0)
      .nullable()
      .describe(
        "This setter's share of the network total weight_sets; null when the network total is 0.",
      ),
    first_set_at: z.string().nullable(),
    last_set_at: z.string().nullable(),
  })
  .strict()
  .describe(
    "One validator's network-wide weight-setting activity in the window. netuid is set only when hotkey is null (a uid-only identity has no meaning outside its own subnet).",
  );

export const ChainWeightSettersArtifactSchema = z
  .object({
    schema_version: z.int(),
    window: z.enum(["7d", "30d"]).nullable(),
    observed_at: z.string().nullable(),
    // The POPULATION: every distinct setter in the window, whatever the page
    // carries.
    distinct_setters: z.int().min(0),
    weight_sets: z.int().min(0),
    // The PAGE, not the population -- `setters.length`, which is what a
    // caller gets back rather than what exists (#10249). Named here because
    // the name alone reads as a population, and the two sit side by side:
    // measured live, `?limit=20` published `setter_count: 20` beside
    // `distinct_setters: 1247`, and `?limit=100` published 100 beside the
    // same 1247. Unlike `subnet_count` on /chain/weights, this one has a
    // true count beside it already, so making it a second copy of
    // `distinct_setters` would cost the page size and add nothing.
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
