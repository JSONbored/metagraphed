// GET /api/v1/chain/concentration/history (#9628): is the NETWORK getting more
// concentrated? Modeled from src/chain-concentration-history.ts's
// buildChainConcentrationHistory().
import { z } from "zod";
import { ConcentrationMetricsSchema } from "../shared.ts";
import { UnavailableDegradedSchema } from "./event-stream-honesty.ts";

/**
 * One distribution's scorecard, as computeConcentration produced it.
 *
 * DERIVED, because the sentence below was already the contract and the copy
 * that used to sit here was not. The cron stores exactly the card
 * /chain/concentration serves -- src/chain-concentration-history.ts's header
 * says so, and that route declares `ConcentrationMetricsSchema`: twelve
 * measures. This re-listed eight, dropping `top_1pct_share`,
 * `top_5pct_share`, `top_10pct_share`, and `top_20pct_share`, under a
 * docstring promising "identical fields". Every stored card therefore carried
 * four keys its own schema forbade -- 441 conformance violations across the
 * 147 cards in a 30-day window, all of them the same four.
 *
 * #10786 already caught these two schemas disagreeing about NULLABILITY and
 * fixed that half, writing "one shape, two schemas, and only one of them
 * true". The field lists stayed divergent, because fixing a copy leaves it a
 * copy. Deriving is what makes the promise enforceable instead of
 * aspirational.
 *
 * `.required()`, the same spelling routes/domains.ts uses, and for the same
 * reason: `computeConcentration()` returns one fixed shape or null, so a card
 * that exists carries every measure. Deriving withOUT it would have quietly
 * dropped this component's `required` list from eight keys to two -- fixing
 * the missing four by weakening the eight that were already right. Checked
 * against production before choosing: all 147 cards in the live 30-day window
 * carry all twelve keys, none of them null.
 */
export const ChainConcentrationScorecardSchema =
  ConcentrationMetricsSchema.unwrap()
    .required()
    .describe(
      "One distribution's concentration scorecard, passed through from the stored card -- identical by construction to the live /chain/concentration card, because it is the same card.",
    );

export const ChainConcentrationHistoryPointSchema = z
  .object({
    day: z.string(),
    /** The shape of the day the card was computed over -- a point across half
     * the network is not comparable to one across all of it. */
    neuron_count: z
      .int()
      .min(0)
      .nullable()
      .describe(
        "The shape of the day the card was computed over -- a point across half the network is not comparable to one across all of it.",
      ),
    subnet_count: z.int().min(0).nullable(),
    entity_count: z.int().min(0).nullable(),
    /** WHEN the network looked like this, as distinct from when it was
     * computed. */
    source_captured_at: z.iso
      .datetime()
      .nullable()
      .describe(
        "WHEN the network looked like this, as distinct from when it was computed.",
      ),
    /** Which definition of the metrics produced this point. Comparing across a
     * change here compares two definitions, not two networks. */
    builder_version: z
      .int()
      .nullable()
      .describe("Which definition of the metrics produced this point."),
    uids_per_entity: z.number().nullable(),
    /** NULL means no measurable distribution, NOT missing -- substituting zeros
     * would invent a perfectly equal one. */
    stake: ChainConcentrationScorecardSchema.nullable().describe(
      "NULL means no measurable distribution, NOT missing.",
    ),
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
    point_count: z
      .int()
      .min(0)
      .nullable()
      .describe(
        "From the ROWS. A day the capture did not run is absent, never a zero-concentration point.",
      ),
    oldest_day: z.string().nullable(),
    newest_day: z.string().nullable(),
    /** More than one means the series changes DEFINITION partway along, and a
     * trend drawn across the boundary is not a trend. */
    builder_versions: z
      .array(z.int())
      .describe(
        "Every distinct builder version in the series. More than one means it changes DEFINITION partway along.",
      ),
    points: z.array(ChainConcentrationHistoryPointSchema),
    /** Present ONLY on a decline. An empty window is a measurement. */
    degraded: UnavailableDegradedSchema.optional().describe(
      "Present ONLY on a decline. An empty window is a measurement.",
    ),
  })
  .strict();
export type ChainConcentrationHistoryArtifact = z.infer<
  typeof ChainConcentrationHistoryArtifactSchema
>;
