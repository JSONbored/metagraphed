// GET /api/v1/subnets/{netuid}/ohlc (types-epic B batch 2, #8056). Live
// account_events-tier candlesticks -- no static file. Modeled from
// src/subnet-ohlc.ts's buildSubnetOhlc(), cross-checked against the
// hand-edited SubnetOhlcArtifact/SubnetOhlcCandle components it replaces.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";
import { EpochMillisSchema } from "../shared.ts";

const SubnetOhlcCandleSchema = z
  .object({
    // EpochMillis, not z.int(): the description already SAID "a Float, since
    // epoch-ms exceeds GraphQL's 32-bit Int" and the emitter published Int
    // anyway, because prose is not a fact a generator can read (#10386).
    // Production serves 1786323600000 here on 1371 of 1371 observed candles.
    bucket_start: EpochMillisSchema.describe(
      "Bucket start as epoch milliseconds -- a Float, since epoch-ms exceeds GraphQL's 32-bit Int.",
    ),
    bucket_start_iso: z.iso.datetime(),
    open: z.number(),
    high: z.number(),
    low: z.number(),
    close: z.number(),
    volume_alpha: z.number().min(0),
    volume_tao: z.number(),
    event_count: z.int().min(0),
    // USD (#10382). NULLABLE, never absent: a candle older than tao_usd_index
    // has no rate, and the hole has to be visible to a caller mapping the
    // array. Emitting today's rate backwards would produce a chart that renders
    // perfectly and is wrong at every point but the last.
    open_usd: z.number().nullable(),
    high_usd: z.number().nullable(),
    low_usd: z.number().nullable(),
    close_usd: z.number().nullable(),
    volume_usd: z.number().nullable(),
    usd_per_tao: z
      .number()
      .nullable()
      .describe(
        "The single TAO/USD rate every _usd field on THIS candle was multiplied by -- the last reading observed inside this candle's own bucket. One rate per candle, so the OHLC ordering (high >= open, close, low) survives the conversion.",
      ),
  })
  .strict();

export const SubnetOhlcArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    interval: z
      .enum(["1h", "1d"])
      .describe("The resolved bucket interval (1h/1d)."),
    candles: z.array(SubnetOhlcCandleSchema),
    candle_count: z
      .int()
      .min(0)
      .describe(
        "How many candles the WINDOW holds, not how many this page carries. A `limit` narrows `candles` from the recent end; this stays the denominator, the same convention /chain/deregistrations uses for its own page.",
      ),
    root_excluded: z
      .boolean()
      .describe(
        "True for root (netuid 0), whose 1:1 price makes candles meaningless, so none are emitted.",
      ),
    usd_available_from: EpochMillisSchema.nullable().describe(
      "Bucket start of the OLDEST candle carrying USD, or null when none does. Published rather than left to be inferred from where the nulls stop, so a caller can render 'USD from <date>' instead of a series that silently changes meaning partway along.",
    ),
    usd_available_from_iso: z.iso.datetime().nullable(),
    priced_candle_count: z
      .int()
      .min(0)
      .describe(
        "How many candles carry USD. A gap against candle_count is the TAO series outrunning the TAO/USD index, not a defect.",
      ),
    usd_unavailable: z
      .enum([
        "no_index_reading",
        "index_unpriced",
        "index_stale",
        "no_alpha_price",
        "read_failed",
      ])
      .nullable()
      .describe(
        "Why NO candle could be priced, or null. `index_unpriced` is ADR 0025's insufficient_pools -- a stated decline, never a price of zero; `read_failed` means the index could not be queried at all, which is not a claim about the index. A partially-priced series leaves this null and explains itself through usd_available_from.",
      ),
    field_sources_usd: z
      .object({
        kind: z.literal("reconstructed"),
        storage: z.null(),
      })
      .strict()
      .describe(
        "Every _usd field is RECONSTRUCTED -- the product of a measured alpha price and a measured TAO/USD index, which is our arithmetic and not a chain read.",
      ),
  })
  .strict()
  .describe(
    "One subnet's alpha-price OHLC candles (#6979). Mirrors GET /api/v1/subnets/{netuid}/ohlc' data envelope.",
  );
export type SubnetOhlcArtifact = z.infer<typeof SubnetOhlcArtifactSchema>;
export const SubnetOhlcResponseSchema = successEnvelopeSchema(
  SubnetOhlcArtifactSchema,
);
