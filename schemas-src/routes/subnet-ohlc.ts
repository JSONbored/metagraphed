// GET /api/v1/subnets/{netuid}/ohlc (types-epic B batch 2, #8056). Live
// account_events-tier candlesticks -- no static file. Modeled from
// src/subnet-ohlc.ts's buildSubnetOhlc(), cross-checked against the
// hand-edited SubnetOhlcArtifact/SubnetOhlcCandle components it replaces.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";

const SubnetOhlcCandleSchema = z
  .object({
    bucket_start: z.int(),
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
    interval: z.enum(["1h", "1d"]),
    candles: z.array(SubnetOhlcCandleSchema),
    root_excluded: z.boolean(),
  })
  .strict();
export type SubnetOhlcArtifact = z.infer<typeof SubnetOhlcArtifactSchema>;
export const SubnetOhlcResponseSchema = successEnvelopeSchema(
  SubnetOhlcArtifactSchema,
);

export const SubnetOhlcQuerySchema = z
  .object({
    interval: z.enum(["1h", "1d"]).optional(),
    days: z.int().min(1).max(365).optional(),
  })
  .strict();
export type SubnetOhlcQuery = z.infer<typeof SubnetOhlcQuerySchema>;
