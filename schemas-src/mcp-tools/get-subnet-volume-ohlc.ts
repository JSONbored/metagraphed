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
import { ROUTE_QUERY_SCHEMAS } from "../route-queries.ts";
import { netuidSchema } from "./shared.ts";
import { SubnetAlphaVolumeArtifactSchema } from "../routes/subnet-alpha-volume.ts";
import { SubnetOhlcArtifactSchema } from "../routes/subnet-ohlc.ts";
import { limitSchema } from "../query-params.ts";
import { MAX_CANDLES } from "../../src/subnet-ohlc.ts";

/**
 * Candles this tool serves when the caller names no `limit`.
 *
 * A week of hourly candles -- the question an agent actually asks about a
 * subnet's price. PUBLISHED here and read by the dispatcher rather than
 * restated there (#10096): the schema's `.meta({ default })` is the single
 * source, and a second literal in the handler is how the two come to disagree.
 */
export const GET_SUBNET_OHLC_CANDLE_DEFAULT = 168;

const RouteQuery_subnets_netuid_ohlc =
  ROUTE_QUERY_SCHEMAS["/api/v1/subnets/{netuid}/ohlc"];

export const GetSubnetVolumeInputSchema = z
  .object({
    netuid: netuidSchema(),
  })
  .strict();
export type GetSubnetVolumeInput = z.infer<typeof GetSubnetVolumeInputSchema>;

export const GetSubnetVolumeOutputSchema = SubnetAlphaVolumeArtifactSchema;
export type GetSubnetVolumeOutput = z.infer<typeof GetSubnetVolumeOutputSchema>;

const OHLC_INTERVALS = ["1h", "1d"] as const;

export const GetSubnetOhlcInputSchema = z
  .object({
    netuid: netuidSchema(),
    interval: RouteQuery_subnets_netuid_ohlc.shape.interval
      .describe("Bucket size for the returned series.")
      .meta({ examples: [OHLC_INTERVALS[0]] }),
    days: RouteQuery_subnets_netuid_ohlc.shape.days
      .describe("How many trailing days to cover, ending today (UTC).")
      .meta({ examples: [7, 30] }),
    // Defaults to a PAGE of candles, not the route's cap (#10318). Measured
    // live: the uncapped answer is 486 KB and 13.5 s, the largest and slowest
    // response this server produces, and 1h over the default 90 days is
    // 2,000 candles nobody asked for. 168 is a week of hourly candles -- the
    // question an agent actually asks -- and `candle_count` still reports what
    // the window holds, so narrowing costs no context. Same split #10027 made
    // for get_health_trends: the route keeps its default, the tool serves a
    // page.
    limit: limitSchema(MAX_CANDLES, GET_SUBNET_OHLC_CANDLE_DEFAULT)
      .describe(
        "How many candles to return, newest first. The window is unchanged -- `candle_count` reports what it holds.",
      )
      .meta({ examples: [168, 24] })
      .optional(),
  })
  .strict();
export type GetSubnetOhlcInput = z.infer<typeof GetSubnetOhlcInputSchema>;

// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note from the pilot batch).
export const GetSubnetOhlcOutputSchema = SubnetOhlcArtifactSchema;
export type GetSubnetOhlcOutput = z.infer<typeof GetSubnetOhlcOutputSchema>;
