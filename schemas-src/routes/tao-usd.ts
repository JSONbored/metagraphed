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

export const TaoUsdArtifactSchema = z
  .object({
    schema_version: z.int(),
    window: z.string().nullable(),
    point_count: z.int().min(0),
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
  .passthrough();
export type TaoUsdArtifact = z.infer<typeof TaoUsdArtifactSchema>;
