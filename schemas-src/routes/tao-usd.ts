// GET /api/v1/network/tao-usd (#9609): the TAO/USD index and its recent series.
// Modeled from src/tao-usd-series.ts's buildTaoUsdSeries().
//
// `usd_per_tao` is NULLABLE throughout, and that is the contract rather than
// laxity: the producer writes `price_basis: insufficient_pools` with a null
// price when the two-pool quorum was not met, and 0004_user_state.sql enforces
// the pairing as a CHECK. Null means "not priceable at that block"; a zero
// would mean TAO is worthless.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";

export const TaoUsdPointSchema = z
  .object({
    observed_at: z.iso.datetime(),
    block_number: z.int().nullable(),
    usd_per_tao: z.number().positive().nullable(),
  })
  .strict();

export const TaoUsdLatestSchema = z
  .object({
    usd_per_tao: z.number().positive().nullable(),
    /** Stated even when the price is null -- it is what says WHY. */
    price_basis: z.string().nullable(),
    /** The ETH/USDC anchor leg the composition multiplied through. */
    eth_usd: z.number().positive().nullable(),
    block_number: z.int().nullable(),
    observed_at: z.iso.datetime().nullable(),
    pool_count: z.int().min(0).nullable(),
    /** Per-pool provenance as the producer stored it. */
    pools: z.array(z.unknown()),
  })
  .strict();

export const TaoUsdArtifactSchema = z
  .object({
    schema_version: z.int(),
    window: z.string().nullable(),
    point_count: z.int().min(0),
    /** How many points carried a price. A gap from point_count is how a window
     * with unpriceable blocks announces itself. */
    priced_point_count: z.int().min(0),
    latest: TaoUsdLatestSchema.nullable(),
    /** How far back the answer actually reaches -- the series began 2026-08-02,
     * so a wide window returns everything rather than the window's span. */
    oldest_observed_at: z.iso.datetime().nullable(),
    change_usd: z.number().nullable(),
    change_pct: z.number().nullable(),
    points: z.array(TaoUsdPointSchema),
  })
  .passthrough();
export type TaoUsdArtifact = z.infer<typeof TaoUsdArtifactSchema>;
export const TaoUsdResponseSchema = successEnvelopeSchema(TaoUsdArtifactSchema);
export const TaoUsdQuerySchema = z
  .object({ window: z.enum(["1h", "24h", "7d", "30d"]).optional() })
  .strict();
