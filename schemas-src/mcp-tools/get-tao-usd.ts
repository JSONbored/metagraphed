// get_tao_usd (#9609): the TAO/USD index, mirroring GET /api/v1/network/tao-usd.
import { z } from "zod";
import { windowSchema } from "./shared.ts";

export const GetTaoUsdInputSchema = z
  .object({
    window: windowSchema(["1h", "24h", "7d", "30d"]).optional(),
    // #9720. The series is ~1,428 points and ~143 KB on the default window,
    // while every summary a caller usually wants -- latest, change_usd,
    // change_pct, point_count, priced_point_count, oldest_observed_at -- sits
    // beside it as a top-level scalar. DEFAULTS TO FALSE HERE and to true on
    // the REST route: a browser can stream 143 KB and a context window cannot,
    // so the surface with the hard constraint carries the default (the same
    // asymmetry #9701 established for list_candidates).
    include_points: z
      .boolean()
      .optional()
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

export const GetTaoUsdOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    window: z.string().nullable(),
    point_count: z.int(),
    priced_point_count: z.int(),
    latest: z
      .object({
        usd_per_tao: z.number().nullable(),
        price_basis: z.string().nullable(),
        eth_usd: z.number().nullable(),
        block_number: z.int().nullable(),
        observed_at: z.string().nullable(),
        pool_count: z.int().nullable(),
        pools: z.array(z.unknown()),
      })
      .passthrough()
      .nullable(),
    oldest_observed_at: z.string().nullable(),
    change_usd: z.number().nullable(),
    change_pct: z.number().nullable(),
    // Optional because `include_points: false` OMITS the key rather than
    // sending an empty array (#9720): an empty array is indistinguishable from
    // a window that priced nothing, and the counts above already say how many
    // points exist.
    points: z
      .array(
        z
          .object({
            observed_at: z.string(),
            block_number: z.int().nullable(),
            usd_per_tao: z.number().nullable(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();
export type GetTaoUsdOutput = z.infer<typeof GetTaoUsdOutputSchema>;
