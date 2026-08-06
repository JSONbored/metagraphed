// GET /api/v1/chain/concentration/history (#9628): is the NETWORK getting more
// concentrated? Modeled from src/chain-concentration-history.ts's
// buildChainConcentrationHistory().
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";

/** One distribution's scorecard, as computeConcentration produced it. Passed
 * through from the stored card rather than re-shaped, so a historical point and
 * the live /chain/concentration card carry identical fields. */
export const ChainConcentrationScorecardSchema = z
  .object({
    holders: z.int().min(0),
    total: z.number(),
    gini: z.number().nullable(),
    hhi: z.number().nullable(),
    hhi_normalized: z.number().nullable(),
    nakamoto_coefficient: z.int().nullable(),
    entropy: z.number().nullable(),
    entropy_normalized: z.number().nullable(),
  })
  .passthrough();

export const ChainConcentrationHistoryPointSchema = z
  .object({
    day: z.string(),
    /** The shape of the day the card was computed over -- a point across half
     * the network is not comparable to one across all of it. */
    neuron_count: z.int().min(0).nullable(),
    subnet_count: z.int().min(0).nullable(),
    entity_count: z.int().min(0).nullable(),
    /** WHEN the network looked like this, as distinct from when it was
     * computed. */
    source_captured_at: z.iso.datetime().nullable(),
    /** Which definition of the metrics produced this point. Comparing across a
     * change here compares two definitions, not two networks. */
    builder_version: z.int().nullable(),
    uids_per_entity: z.number().nullable(),
    /** NULL means no measurable distribution, NOT missing -- substituting zeros
     * would invent a perfectly equal one. */
    stake: ChainConcentrationScorecardSchema.nullable(),
    emission: ChainConcentrationScorecardSchema.nullable(),
    entity_stake: ChainConcentrationScorecardSchema.nullable(),
    entity_emission: ChainConcentrationScorecardSchema.nullable(),
    validator_stake: ChainConcentrationScorecardSchema.nullable(),
  })
  .strict();

export const ChainConcentrationHistoryArtifactSchema = z
  .object({
    schema_version: z.int(),
    window: z.string().nullable(),
    /** From the ROWS. A day the capture did not run is absent, never a
     * zero-concentration point. */
    point_count: z.int().min(0).nullable(),
    oldest_day: z.string().nullable(),
    newest_day: z.string().nullable(),
    /** More than one means the series changes DEFINITION partway along, and a
     * trend drawn across the boundary is not a trend. */
    builder_versions: z.array(z.int()),
    points: z.array(ChainConcentrationHistoryPointSchema),
    /** Present ONLY on a decline. An empty window is a measurement. */
    degraded: z
      .object({ reason: z.enum(["unavailable"]) })
      .strict()
      .optional(),
  })
  .passthrough();
export type ChainConcentrationHistoryArtifact = z.infer<
  typeof ChainConcentrationHistoryArtifactSchema
>;
export const ChainConcentrationHistoryResponseSchema = successEnvelopeSchema(
  ChainConcentrationHistoryArtifactSchema,
);
