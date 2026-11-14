// GET /api/v1/network/tao-usd (#9609): the TAO/USD index and its recent series.
// Modeled from src/tao-usd-series.ts's buildTaoUsdSeries().
//
// `usd_per_tao` is NULLABLE throughout, and that is the contract rather than
// laxity: the producer writes `price_basis: insufficient_pools` with a null
// price when the two-pool quorum was not met, and 0004_user_state.sql enforces
// the pairing as a CHECK. Null means "not priceable at that block"; a zero
// would mean TAO is worthless.
import { z } from "zod";
import { DurationMillisSchema } from "../shared.ts";

export const TaoUsdPointSchema = z
  .object({
    observed_at: z.iso.datetime(),
    block_number: z.int().nullable(),
    usd_per_tao: z
      .number()
      .positive()
      .nullable()
      .describe(
        "Null means the block was not priceable (insufficient pool quorum), NOT a zero price.",
      ),
  })
  .strict()
  .describe("One TAO/USD reading.");

export const TaoUsdLatestSchema = z
  .object({
    usd_per_tao: z.number().positive().nullable(),
    /** Stated even when the price is null -- it is what says WHY. */
    price_basis: z
      .string()
      .nullable()
      .describe("Stated even when the price is null -- it is what says why."),
    /** The ETH/USDC anchor leg the composition multiplied through. */
    eth_usd: z
      .number()
      .positive()
      .nullable()
      .describe("The ETH/USDC anchor leg the composition multiplied through."),
    block_number: z.int().nullable(),
    observed_at: z.iso.datetime().nullable(),
    pool_count: z.int().min(0).nullable(),
    /** Per-pool provenance as the producer stored it. */
    pools: z
      .array(z.unknown())
      .describe("Per-pool provenance as the producer stored it."),
  })
  .strict()
  .describe(
    "The newest reading with the derivation that produced it, kept together so both describe the same block.",
  );

export const TaoUsdOracleFeedSchema = z
  .object({
    block_number: z.int().min(0),
    usd_per_tao: z
      .number()
      .positive()
      .nullable()
      .describe(
        "The fed USD-per-TAO figure as the engine's decode normalized it. Null when the feed could not be normalized, NOT a zero price.",
      ),
    observed_at: z.iso.datetime().nullable(),
  })
  .strict()
  .describe("One TaoUsdPriceFed reading, pinned to the block it landed at.");

export const TaoUsdOracleSchema = z
  .object({
    /** The label that tells this block from the composed index beside it. */
    source: z
      .literal("chain_oracle")
      .describe(
        "Always `chain_oracle`: this block is the chain's own TaoUsdPrice, as opposed to the composed off-chain index beside it (source `pool_composite`).",
      ),
    usd_per_tao: z
      .number()
      .positive()
      .nullable()
      .describe(
        "The current on-chain USD-per-TAO figure (SubtensorModule.TaoUsdPrice; the newest feed). Null when the newest feed could not be normalized, NOT a zero price.",
      ),
    price_raw: z
      .string()
      .nullable()
      .describe(
        "The chain's raw price encoding at the newest feed, verbatim as a canonical decimal string -- the engine's decode owns the scaling, so the raw value rides along for audit rather than being re-derived.",
      ),
    oracle: z
      .string()
      .nullable()
      .describe(
        "The authorized feeder account (SubtensorModule.TaoUsdPriceOracle) at the newest feed, as an ss58 address. Null when the capture did not carry it.",
      ),
    block_number: z.int().min(0),
    observed_at: z.iso.datetime().nullable(),
    captured_at: z.iso.datetime().nullable(),
    /** Never 0: a block with no feeds is served as `oracle: null`, not as a
     * zero-feed history. */
    fed_count: z
      .int()
      .min(1)
      .describe(
        "How many feeds this block carries -- `feeds.length`, store-capped. Never 0: with no captured feeds the whole block is null instead.",
      ),
    feeds: z
      .array(TaoUsdOracleFeedSchema)
      .describe(
        "The TaoUsdPriceFed history, newest first and store-capped. The first entry is the current on-chain price.",
      ),
  })
  .strict()
  .describe(
    "The chain's own TAO/USD oracle (#13164): the current SubtensorModule.TaoUsdPrice with its feeder and the TaoUsdPriceFed history behind it. Null on the card until the engine's oracle capture lands -- an absent capture is never served as a price.",
  );

export const TaoUsdArtifactSchema = z
  .object({
    schema_version: z.int(),
    window: z.string().nullable(),
    point_count: z.int().min(0),
    /**
     * THE SOURCE IS STATED, NOT INFERRED (#13164). Everything on this card
     * except `oracle` is the off-chain composed index (ADR 0025); the
     * on-chain oracle block beside it carries its own `chain_oracle` label,
     * so a consumer never has to guess which provenance a figure has.
     */
    source: z
      .literal("pool_composite")
      .describe(
        "Always `pool_composite`: the price series and `latest` on this card are the composed off-chain index (ADR 0025 -- a liquidity-weighted median across wTAO/WETH pools through an ETH/USDC anchor). The chain's own price, when captured, is the separate `oracle` block labelled `chain_oracle`.",
      ),
    // STALENESS IS STATED, NOT INFERRED (#8601 requirement 3). A consumer that
    // has to parse observed_at, know the bound, and compare correctly has three
    // chances to get it wrong -- and one that skips the check reads a frozen
    // rate as a current one.
    stale: z
      .boolean()
      .describe(
        "True when the newest reading is older than stale_after_ms, or carries no usable timestamp at all. A reading that cannot say WHEN it was taken counts as stale, never fresh.",
      ),
    stale_after_ms: z
      .int()
      .min(0)
      .describe(
        "The bound `stale` is measured against -- the same one the API refuses to derive USD figures from, so 'this response says stale' and 'no USD anywhere on the API' are one condition rather than two that can drift.",
      ),
    age_ms: DurationMillisSchema.nullable().describe(
      "How old the newest reading is, so a caller can render 'N minutes ago' without re-deriving it. Null when there is no reading.",
    ),
    /** How many points carried a price. A gap from point_count is how a window
     * with unpriceable blocks announces itself. */
    priced_point_count: z
      .int()
      .min(0)
      .describe(
        "How many points carried a price. A gap from point_count is how a window with unpriceable blocks announces itself.",
      ),
    latest: TaoUsdLatestSchema.nullable(),
    /**
     * NULL IS THE DECLINE (#13164). The on-chain oracle's writers -- the
     * engine's TaoUsdPrice / TaoUsdPriceFed decode -- land separately, so an
     * absent block means "the oracle capture has not run", never "the chain
     * has no price".
     */
    oracle: TaoUsdOracleSchema.nullable().describe(
      "The chain's own TAO/USD oracle (SubtensorModule.TaoUsdPrice with its TaoUsdPriceFed history), labelled source `chain_oracle`. NULL until the engine's oracle capture lands (store unbound, or no feed captured): an absent capture is never served as a price.",
    ),
    /** How far back the answer actually reaches -- the series began 2026-08-02,
     * so a wide window returns everything rather than the window's span. */
    oldest_observed_at: z.iso
      .datetime()
      .nullable()
      .describe(
        "How far back the answer actually reaches -- the series began 2026-08-02.",
      ),
    change_usd: z.number().nullable(),
    change_pct: z.number().nullable(),
    points: z.array(TaoUsdPointSchema),
  })
  .strict();
export type TaoUsdArtifact = z.infer<typeof TaoUsdArtifactSchema>;
