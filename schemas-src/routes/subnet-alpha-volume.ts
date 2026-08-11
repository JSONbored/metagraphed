// GET /api/v1/subnets/{netuid}/volume (types-epic B batch 1, #8055). Live
// account_events aggregate -- no static file. Modeled from
// src/alpha-volume.ts's buildAlphaVolume() AlphaVolumeResult interface
// (every field always present, none omitted), cross-checked against the
// hand-edited SubnetAlphaVolumeArtifact component it replaces.
import { z } from "zod";
import { ALPHA_USD_OVERLAY, FieldSourcesSchema } from "../shared.ts";

export const SubnetAlphaVolumeArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    // NULLABLE: the cold-store fallback builds a zeroed card and the resolver
    // writes `window: data.window ?? null` for it (src/graphql.ts). The label
    // describes a window there was no data to cover (#10772).
    window: z
      .enum(["24h"])
      .nullable()
      .describe(
        "The rolling window label this card covers (24h); null on a zeroed cold-store card.",
      ),
    buy_volume_alpha: z.number(),
    sell_volume_alpha: z.number(),
    total_volume_alpha: z.number(),
    buy_volume_tao: z.number(),
    sell_volume_tao: z.number(),
    total_volume_tao: z.number(),
    // USD twins (#10383). OPTIONAL, not nullable: an absent field says "not
    // available" and there is nothing to chart, matching the spot convention
    // src/alpha-usd-overlay.ts uses -- unlike the SERIES routes, where a
    // uniform point shape means an explicit null instead.
    buy_volume_usd: z.number().optional(),
    sell_volume_usd: z.number().optional(),
    total_volume_usd: z.number().optional(),
    buy_count: z.int().min(0),
    sell_count: z.int().min(0),
    net_volume_alpha: z.number(),
    sentiment_ratio: z
      .number()
      .nullable()
      .describe(
        "Buy share of total volume (0-1); null when there was no volume.",
      ),
    sentiment: z
      .enum(["bullish", "bearish", "neutral"])
      .describe(
        "Bucketed reading of sentiment_ratio (buying/selling/neutral).",
      ),
    vol_mcap_ratio: z
      .number()
      .nullable()
      .describe(
        "Total TAO volume over alpha market cap; null when market cap is unknown.",
      ),
    ...ALPHA_USD_OVERLAY,
    usd_pricing_basis: z
      .literal("window_close_rate")
      .optional()
      .describe(
        "HOW the totals were converted: at the rate observed at the window's close, not summed per trade. A string rather than a boolean so a future per-trade implementation publishes a different value instead of silently changing what this shape means.",
      ),
    field_sources: FieldSourcesSchema.optional(),
  })
  .strict()
  .describe(
    "One subnet's rolling 24h alpha trading volume (#6979). Mirrors GET /api/v1/subnets/{netuid}/volume' data envelope.",
  );
export type SubnetAlphaVolumeArtifact = z.infer<
  typeof SubnetAlphaVolumeArtifactSchema
>;
