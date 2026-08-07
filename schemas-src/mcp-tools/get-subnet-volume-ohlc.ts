// MCP tools `get_subnet_volume`, `get_subnet_ohlc`.
// Mirror GET /api/v1/subnets/{netuid}/volume, GET
// /api/v1/subnets/{netuid}/ohlc.
//
// DERIVED FROM THE ROUTE, NOT COPIED (#9796). Each output schema below IS the
// route's own ArtifactSchema, so a route field rename is a compile error here
// instead of silent production drift -- which is what the hand-written copies
// this replaces had already accumulated.
//
// Verified against production before the switch, because deriving is a
// TIGHTENING -- the route schema is stricter than the copy was. Every tool in
// this file was called live and its response validated against the schema it
// now publishes.
import { z } from "zod";
import { netuidSchema } from "./shared.ts";
import { SubnetAlphaVolumeArtifactSchema } from "../routes/subnet-alpha-volume.ts";
import { SubnetOhlcArtifactSchema } from "../routes/subnet-ohlc.ts";

export const GetSubnetVolumeInputSchema = z
  .object({
    netuid: netuidSchema(),
  })
  .strict();
export type GetSubnetVolumeInput = z.infer<typeof GetSubnetVolumeInputSchema>;

export const GetSubnetVolumeOutputSchema = SubnetAlphaVolumeArtifactSchema;
export type GetSubnetVolumeOutput = z.infer<typeof GetSubnetVolumeOutputSchema>;

const OHLC_INTERVALS = ["1h", "1d"] as const;
const MAX_OHLC_WINDOW_DAYS = 365;

export const GetSubnetOhlcInputSchema = z
  .object({
    netuid: netuidSchema(),
    interval: z
      .enum(OHLC_INTERVALS)
      .optional()
      .describe("Bucket size for the returned series.")
      .meta({ examples: [OHLC_INTERVALS[0]] }),
    days: z
      .int()
      .min(1)
      .max(MAX_OHLC_WINDOW_DAYS)
      .optional()
      .describe("How many trailing days to cover, ending today (UTC).")
      .meta({ examples: [7, 30] }),
  })
  .strict();
export type GetSubnetOhlcInput = z.infer<typeof GetSubnetOhlcInputSchema>;

// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note from the pilot batch).
export const GetSubnetOhlcOutputSchema = SubnetOhlcArtifactSchema;
export type GetSubnetOhlcOutput = z.infer<typeof GetSubnetOhlcOutputSchema>;
