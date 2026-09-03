// GET /api/v1/chain/holders (#9607): every subnet ranked by alpha-ownership
// concentration. Modeled from src/chain-holders.ts's buildChainHolders().
//
// There is deliberately NO network-level `total_alpha`. Each subnet's alpha is a
// different token, so a cross-subnet sum has no unit -- #8803 shipped exactly
// that and reported an account at 71% of TAO's hard cap. The network block
// carries only counts and a median of within-subnet ratios, both of which
// survive the mismatch.
import { z } from "zod";

export const ChainHoldersSubnetSchema = z
  .object({
    netuid: z.int().min(0).max(65535),
    holder_count: z.int().min(0).nullable(),
    /** ALPHA, and only comparable WITHIN this subnet. */
    total_alpha: z
      .number()
      .min(0)
      .nullable()
      .describe(
        "ALPHA, comparable only WITHIN this subnet -- each subnet's alpha is a different token.",
      ),
    top1_share: z.number().min(0).max(1).nullable(),
    top5_share: z.number().min(0).max(1).nullable(),
    top10_share: z.number().min(0).max(1).nullable(),
    top20_share: z.number().min(0).max(1).nullable(),
    /** The largest holder's coldkey (an ss58 address) -- public on-chain data. */
    top_holder: z
      .string()
      .nullable()
      .describe("The largest holder's coldkey (an ss58 address)."),
  })
  .strict()
  .describe("One subnet's alpha-ownership concentration.");

export const ChainHoldersNetworkSchema = z
  .object({
    subnets_measured: z.int().min(0).nullable(),
    /** Subnets where ONE account holds a majority of the measured alpha. */
    subnets_with_majority_holder: z
      .int()
      .min(0)
      .nullable()
      .describe(
        "Subnets where ONE account holds a majority of the measured alpha.",
      ),
    /** Subnets whose entire measured alpha sits in a single wallet. */
    subnets_with_single_holder: z
      .int()
      .min(0)
      .nullable()
      .describe("Subnets whose entire measured alpha sits in a single wallet."),
    median_top1_share: z.number().min(0).max(1).nullable(),
  })
  .strict()
  .describe(
    "Dimension-free network facts. There is deliberately no cross-subnet alpha total: summing different subnets' alpha has no unit.",
  );

export const ChainHoldersArtifactSchema = z
  .object({
    schema_version: z.int(),
    sort: z.string(),
    limit: z.int().min(1).nullable(),
    /** Subnets measured, which is NOT the length of `subnets` when limit bites. */
    subnet_count: z
      .int()
      .min(0)
      .nullable()
      .describe(
        "Subnets measured -- NOT the length of the subnets list when limit bites.",
      ),
    network: ChainHoldersNetworkSchema,
    captured_at: z.iso.datetime().nullable(),
    positions_captured_at: z.iso.datetime().nullable(),
    subnets: z.array(ChainHoldersSubnetSchema),
    /** Present ONLY on a decline; its absence says the ranking is real. */
    degraded: z
      .object({ reason: z.enum(["pool_totals_unproven", "unavailable"]) })
      .strict()
      .describe(
        "An event-derived result could not be measured because its source is unavailable, its stream was never emitted, or its derivation could not answer this request. Absent on measured answers, including successfully read quiet windows.",
      )
      .optional()
      .describe(
        "Present ONLY on a decline. An empty subnets list WITHOUT this block is a measurement.",
      ),
  })
  .strict();
export type ChainHoldersArtifact = z.infer<typeof ChainHoldersArtifactSchema>;
