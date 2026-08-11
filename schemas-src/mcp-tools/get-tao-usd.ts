// get_tao_usd (#9609): the TAO/USD index, mirroring GET
// /api/v1/network/tao-usd.
import { z } from "zod";
import { ROUTE_QUERY_SCHEMAS } from "../route-queries.ts";
import { TaoUsdArtifactSchema, TaoUsdPointSchema } from "../routes/tao-usd.ts";

const RouteQuery_network_tao_usd =
  ROUTE_QUERY_SCHEMAS["/api/v1/network/tao-usd"];

export const GetTaoUsdInputSchema = z
  .object({
    window: RouteQuery_network_tao_usd.shape.window,
    // #9720. The series is ~1,428 points and ~143 KB on the default window,
    // while every summary a caller usually wants -- latest, change_usd,
    // change_pct, point_count, priced_point_count, oldest_observed_at -- sits
    // beside it as a top-level scalar. DEFAULTS TO FALSE HERE and to true on
    // the REST route: a browser can stream 143 KB and a context window cannot,
    // so the surface with the hard constraint carries the default (the same
    // asymmetry #9701 established for list_candidates).
    include_points: RouteQuery_network_tao_usd.shape.include_points
      .describe(
        "Include the full per-point price series. Defaults to FALSE here — " +
          "the summary above it (latest, change_usd, change_pct, the counts) " +
          "is computed over the whole window either way, so omitting the " +
          "points narrows the response without narrowing the measurement. " +
          "Set true when you need the series itself.",
      )
      .meta({ default: false, examples: [false] }),
  })
  .strict();
export type GetTaoUsdInput = z.infer<typeof GetTaoUsdInputSchema>;

export const GetTaoUsdOutputSchema = TaoUsdArtifactSchema.extend({
  // DERIVED FROM THE ROUTE (#10790), with the two deltas this surface really
  // has spelled out rather than buried in a re-typed copy. The copy had drifted
  // to `z.string()` where the route says `z.iso.datetime()`, `z.int()` where it
  // says `z.int().min(0)`, and an inline `latest` beside the route's own
  // `TaoUsdLatestSchema` -- four ways to describe one payload.
  // `include_points: false` OMITS the key rather than sending an empty array
  // (#9720): an empty array is indistinguishable from a window that priced
  // nothing, and the counts already say how many points exist.
  points: z.array(TaoUsdPointSchema).optional(),
});
export type GetTaoUsdOutput = z.infer<typeof GetTaoUsdOutputSchema>;
