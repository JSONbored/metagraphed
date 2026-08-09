// GET /api/v1/economics/trends (types-epic B batch 2, #8056). Live
// subnet_snapshots-tier daily network-wide rollup -- no static file.
// Modeled from src/neuron-history.ts's buildEconomicsTrends(), cross-checked
// against the hand-edited EconomicsTrendsArtifact/EconomicsTrendsDay
// components it replaces.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";

/** This route's own vocabulary, owned here so its MCP tool imports rather than restates it (#9799). */
export const ECONOMICS_TRENDS_WINDOW_VALUES = [
  "7d",
  "30d",
  "90d",
  "1y",
  "all",
] as const;

const RaoPrecisionTaoStringSchema = z.string().regex(/^\d+\.\d{9}$/);

const EconomicsTrendsDaySchema = z
  .object({
    snapshot_date: z.string(),
    subnet_count: z.int().min(0),
    total_stake_alpha: RaoPrecisionTaoStringSchema.nullable()
      .optional()
      .describe(
        "Lossless fixed 9-decimal (rao-precision) TAO string, summed across every subnet reporting that day -- exceeds the exact-double ceiling as a JSON number, so it is served as a string rather than Float.",
      ),
    alpha_price_tao_weighted: z.number().nullable().optional(),
    alpha_price_tao_median: z.number().nullable().optional(),
    validator_count: z.int().nullable().optional(),
    miner_count: z.int().nullable().optional(),
    mean_emission_share: z.number().nullable().optional(),
  })
  .strict()
  .describe(
    "One UTC day of network-wide economics aggregated across every subnet with a snapshot that day. Sums are null only when no subnet reported a value that day.",
  );

export const EconomicsTrendsArtifactSchema = z
  .object({
    schema_version: z.int(),
    window: z.string().nullable(),
    day_count: z.int().min(0),
    days: z.array(EconomicsTrendsDaySchema),
  })
  .passthrough();
export type EconomicsTrendsArtifact = z.infer<
  typeof EconomicsTrendsArtifactSchema
>;
export const EconomicsTrendsResponseSchema = successEnvelopeSchema(
  EconomicsTrendsArtifactSchema,
);
