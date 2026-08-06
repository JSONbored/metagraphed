// GET /api/v1/chain/holders (#9607): every subnet ranked by alpha-ownership
// concentration. Modeled from src/chain-holders.ts's buildChainHolders().
//
// There is deliberately NO network-level `total_alpha`. Each subnet's alpha is a
// different token, so a cross-subnet sum has no unit -- #8803 shipped exactly
// that and reported an account at 71% of TAO's hard cap. The network block
// carries only counts and a median of within-subnet ratios, both of which
// survive the mismatch.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";
import { CHAIN_HOLDERS_LIMIT_MAX } from "../../src/route-limits.ts";

export const ChainHoldersSubnetSchema = z
  .object({
    netuid: z.int().min(0).max(65535),
    holder_count: z.int().min(0).nullable(),
    /** ALPHA, and only comparable WITHIN this subnet. */
    total_alpha: z.number().min(0).nullable(),
    top1_share: z.number().min(0).max(1).nullable(),
    top5_share: z.number().min(0).max(1).nullable(),
    top10_share: z.number().min(0).max(1).nullable(),
    top20_share: z.number().min(0).max(1).nullable(),
    /** The largest holder's coldkey (an ss58 address) -- public on-chain data. */
    top_holder: z.string().nullable(),
  })
  .strict();

export const ChainHoldersNetworkSchema = z
  .object({
    subnets_measured: z.int().min(0).nullable(),
    /** Subnets where ONE account holds a majority of the measured alpha. */
    subnets_with_majority_holder: z.int().min(0).nullable(),
    /** Subnets whose entire measured alpha sits in a single wallet. */
    subnets_with_single_holder: z.int().min(0).nullable(),
    median_top1_share: z.number().min(0).max(1).nullable(),
  })
  .strict();

export const ChainHoldersArtifactSchema = z
  .object({
    schema_version: z.int(),
    sort: z.string(),
    limit: z.int().min(1).nullable(),
    /** Subnets measured, which is NOT the length of `subnets` when limit bites. */
    subnet_count: z.int().min(0).nullable(),
    network: ChainHoldersNetworkSchema,
    captured_at: z.iso.datetime().nullable(),
    positions_captured_at: z.iso.datetime().nullable(),
    subnets: z.array(ChainHoldersSubnetSchema),
    /** Present ONLY on a decline; its absence says the ranking is real. */
    degraded: z
      .object({ reason: z.enum(["pool_totals_unproven", "unavailable"]) })
      .strict()
      .optional(),
  })
  .passthrough();
export type ChainHoldersArtifact = z.infer<typeof ChainHoldersArtifactSchema>;
export const ChainHoldersResponseSchema = successEnvelopeSchema(
  ChainHoldersArtifactSchema,
);
export const ChainHoldersQuerySchema = z
  .object({
    sort: z
      .enum([
        "top1_share",
        "top5_share",
        "top10_share",
        "top20_share",
        "holder_count",
        "total_alpha",
      ])
      .optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(CHAIN_HOLDERS_LIMIT_MAX)
      .optional(),
  })
  .strict();
