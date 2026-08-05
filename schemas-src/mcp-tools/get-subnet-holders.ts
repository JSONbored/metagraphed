// get_subnet_holders (#9557): the per-subnet alpha holder leaderboard, mirroring
// GET /api/v1/subnets/{netuid}/holders.
//
// The output mirrors src/subnet-holders.ts's buildSubnetHolders() rather than
// the route schema's stricter form, following every sibling tool here: a tool
// output is read by a model, so it stays permissive about extra keys and states
// only the fields a caller may rely on.
import { z } from "zod";
import { SUBNET_HOLDERS_LIMIT_MAX } from "../../src/route-limits.ts";

export const GetSubnetHoldersInputSchema = z
  .object({
    netuid: z.int().min(0).max(65535),
    limit: z.int().min(1).max(SUBNET_HOLDERS_LIMIT_MAX).optional(),
  })
  .strict();
export type GetSubnetHoldersInput = z.infer<typeof GetSubnetHoldersInputSchema>;

export const GetSubnetHoldersOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    netuid: z.int(),
    limit: z.int().nullable(),
    // Whole-subnet, never bounded by the returned page.
    holder_count: z.int().nullable(),
    total_alpha: z.number().nullable(),
    concentration: z
      .object({
        top5_share: z.number().nullable(),
        top10_share: z.number().nullable(),
        top20_share: z.number().nullable(),
      })
      .passthrough(),
    captured_at: z.string().nullable(),
    positions_captured_at: z.string().nullable(),
    holders: z.array(
      z
        .object({
          coldkey: z.string(),
          alpha: z.number(),
          share_of_total: z.number().nullable(),
          hotkey_count: z.int().nullable(),
        })
        .passthrough(),
    ),
    // Present ONLY when the ranking was declined. A model seeing `holders: []`
    // must read this before concluding the subnet has no holders.
    degraded: z
      .object({
        reason: z.enum([
          "pool_totals_unproven",
          "root_not_in_alpha_map",
          "unavailable",
        ]),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type GetSubnetHoldersOutput = z.infer<
  typeof GetSubnetHoldersOutputSchema
>;
