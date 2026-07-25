// MCP tools `get_subnet_volume`, `get_subnet_ohlc` (types-epic E batch 4,
// #8067). get_subnet_volume mirrors GET /api/v1/subnets/{netuid}/volume,
// covered by schemas-src/routes/subnet-alpha-volume.ts (#8055) -- NOT
// reused: that REST schema is `.strict()` with all 15 fields required; this
// tool's own hand-written original requires only netuid+window, leaving
// every numeric field optional. Reusing would substantially tighten this
// tool's existing contract. get_subnet_ohlc mirrors GET /api/v1/subnets/
// {netuid}/ohlc, which is not one of schemas-src/routes/'s covered pilot
// routes -- no existing Zod schema to reuse either. Both modeled fresh,
// shallow, from the hand-written literals they replace.
import { z } from "zod";

export const GetSubnetVolumeInputSchema = z
  .object({
    netuid: z.int().min(0),
  })
  .strict();
export type GetSubnetVolumeInput = z.infer<typeof GetSubnetVolumeInputSchema>;

export const GetSubnetVolumeOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    netuid: z.int(),
    window: z.string(),
    buy_volume_alpha: z.unknown().optional(),
    sell_volume_alpha: z.unknown().optional(),
    total_volume_alpha: z.unknown().optional(),
    buy_volume_tao: z.unknown().optional(),
    sell_volume_tao: z.unknown().optional(),
    total_volume_tao: z.unknown().optional(),
    buy_count: z.int().optional(),
    sell_count: z.int().optional(),
    net_volume_alpha: z.unknown().optional(),
    sentiment_ratio: z.number().nullable().optional(),
    sentiment: z.string().nullable().optional(),
    vol_mcap_ratio: z.number().nullable().optional(),
  })
  .passthrough();
export type GetSubnetVolumeOutput = z.infer<typeof GetSubnetVolumeOutputSchema>;

const OHLC_INTERVALS = ["1h", "1d"] as const;
const MAX_OHLC_WINDOW_DAYS = 365;

export const GetSubnetOhlcInputSchema = z
  .object({
    netuid: z.int().min(0),
    interval: z.enum(OHLC_INTERVALS).optional(),
    days: z.int().min(1).max(MAX_OHLC_WINDOW_DAYS).optional(),
  })
  .strict();
export type GetSubnetOhlcInput = z.infer<typeof GetSubnetOhlcInputSchema>;

// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note from the pilot batch).
const OhlcCandleSchema = z
  .object({
    bucket_start: z.int().optional(),
    bucket_start_iso: z.string().optional(),
    open: z.unknown().optional(),
    high: z.unknown().optional(),
    low: z.unknown().optional(),
    close: z.unknown().optional(),
    volume_alpha: z.unknown().optional(),
    volume_tao: z.unknown().optional(),
    event_count: z.int().optional(),
  })
  .passthrough();

export const GetSubnetOhlcOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    netuid: z.int(),
    interval: z.string(),
    candles: z.array(OhlcCandleSchema),
    root_excluded: z.boolean(),
  })
  .passthrough();
export type GetSubnetOhlcOutput = z.infer<typeof GetSubnetOhlcOutputSchema>;
