// get_tao_usd (#9609): the TAO/USD index, mirroring GET /api/v1/network/tao-usd.
import { z } from "zod";
import { windowSchema } from "./shared.ts";

export const GetTaoUsdInputSchema = z
  .object({ window: windowSchema(["1h", "24h", "7d", "30d"]).optional() })
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
    points: z.array(
      z
        .object({
          observed_at: z.string(),
          block_number: z.int().nullable(),
          usd_per_tao: z.number().nullable(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
export type GetTaoUsdOutput = z.infer<typeof GetTaoUsdOutputSchema>;
