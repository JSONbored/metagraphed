// get_chain_holders (#9607): every subnet ranked by alpha-ownership
// concentration, mirroring GET /api/v1/chain/holders.
import { z } from "zod";
import { limitSchema, netuidSchema, sortSchema } from "./shared.ts";
import {
  CHAIN_HOLDERS_LIMIT_DEFAULT,
  CHAIN_HOLDERS_LIMIT_MAX,
} from "../../src/route-limits.ts";

export const GetChainHoldersInputSchema = z
  .object({
    sort: sortSchema([
      "top1_share",
      "top5_share",
      "top10_share",
      "top20_share",
      "holder_count",
      "total_alpha",
    ]).optional(),
    limit: limitSchema(
      CHAIN_HOLDERS_LIMIT_MAX,
      CHAIN_HOLDERS_LIMIT_DEFAULT,
    ).optional(),
  })
  .strict();
export type GetChainHoldersInput = z.infer<typeof GetChainHoldersInputSchema>;

export const GetChainHoldersOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    sort: z.string(),
    limit: z.int().nullable(),
    subnet_count: z.int().nullable(),
    network: z
      .object({
        subnets_measured: z.int().nullable(),
        subnets_with_majority_holder: z.int().nullable(),
        subnets_with_single_holder: z.int().nullable(),
        median_top1_share: z.number().nullable(),
      })
      .passthrough(),
    captured_at: z.string().nullable(),
    positions_captured_at: z.string().nullable(),
    subnets: z.array(
      z
        .object({
          netuid: netuidSchema(),
          holder_count: z.int().nullable(),
          total_alpha: z.number().nullable(),
          top1_share: z.number().nullable(),
          top5_share: z.number().nullable(),
          top10_share: z.number().nullable(),
          top20_share: z.number().nullable(),
          top_holder: z.string().nullable(),
        })
        .passthrough(),
    ),
    // Present ONLY on a decline. A model seeing an empty `subnets` must read
    // this before concluding the network has no measured holders.
    degraded: z
      .object({ reason: z.enum(["pool_totals_unproven", "unavailable"]) })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type GetChainHoldersOutput = z.infer<typeof GetChainHoldersOutputSchema>;
