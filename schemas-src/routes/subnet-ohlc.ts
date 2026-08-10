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
  })
  .strict()
  .describe(
    "One subnet's alpha-price OHLC candles (#6979). Mirrors GET /api/v1/subnets/{netuid}/ohlc' data envelope.",
  );
export type SubnetOhlcArtifact = z.infer<typeof SubnetOhlcArtifactSchema>;
export const SubnetOhlcResponseSchema = successEnvelopeSchema(
  SubnetOhlcArtifactSchema,
);
