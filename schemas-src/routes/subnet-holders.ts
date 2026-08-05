// GET /api/v1/subnets/{netuid}/holders (#9557): the per-subnet alpha holder
// leaderboard. Modeled from src/subnet-holders.ts's buildSubnetHolders().
//
// Every aggregate here is NULLABLE for one reason: the route declines rather
// than answering when it cannot prove its inputs (no complete hotkey_alpha pass)
// or when the question has no holder set (netuid 0, which the Alpha map does not
// cover). A declined read carries `holders: []` with `degraded.reason` set and
// every count null -- so `0` in any of these fields is a MEASURED zero, and the
// schema must not let a decline masquerade as one.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";
import { SUBNET_HOLDERS_LIMIT_MAX } from "../../src/route-limits.ts";

export const SubnetHolderSchema = z
  .object({
    coldkey: z.string(),
    // Alpha, not TAO. Within one subnet alpha is already a common unit, so the
    // ranking needs no price join -- and carries none of the price-staleness
    // caveats the chain-wide holdings columns must.
    alpha: z.number().min(0),
    // This holder's alpha over the subnet's FULL measured total, so it means the
    // same thing at ?limit=5 and ?limit=100. Null when the total is zero: with
    // nothing measured there is no share to state.
    share_of_total: z.number().min(0).max(1).nullable(),
    // Distinct hotkeys this coldkey holds the subnet's alpha through --
    // registered on it or not, which is the part reading off `neurons` misses.
    hotkey_count: z.int().min(0).nullable(),
  })
  .strict();

export const SubnetHoldersConcentrationSchema = z
  .object({
    // Each is summed over the top N of the FULL holder set, never over the
    // returned page. Null when there is no total to divide by.
    top5_share: z.number().min(0).max(1).nullable(),
    top10_share: z.number().min(0).max(1).nullable(),
    top20_share: z.number().min(0).max(1).nullable(),
  })
  .strict();

export const SubnetHoldersDegradedSchema = z
  .object({
    reason: z.enum([
      // No hotkey_alpha pass has completed, so pool totals cannot be trusted to
      // rank anything -- a partial ledger underprices rather than visibly
      // dropping rows, which is why this declines instead of serving.
      "pool_totals_unproven",
      // netuid 0: SubtensorModule::Alpha carries no root data at all, so there
      // is no holder set here rather than an empty one.
      "root_not_in_alpha_map",
      // No D1 binding, or the read failed.
      "unavailable",
    ]),
  })
  .strict();

export const SubnetHoldersArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0).max(65535),
    limit: z.int().min(1).nullable(),
    // Distinct coldkeys holding this subnet's alpha -- the whole set, not the
    // returned page's length.
    holder_count: z.int().min(0).nullable(),
    total_alpha: z.number().min(0).nullable(),
    concentration: SubnetHoldersConcentrationSchema,
    // The pool pass every row was valued against. Rows are scoped to ONE
    // captured_at: mixing stamps values a coldkey's positions against totals
    // read at different blocks, which is a silently inconsistent sum.
    captured_at: z.iso.datetime().nullable(),
    // When the positions ledger itself was last written, which advances on a
    // different cadence than the pool totals above.
    positions_captured_at: z.iso.datetime().nullable(),
    holders: z.array(SubnetHolderSchema),
    // Present ONLY on a decline. Its absence is what says the ranking is real.
    degraded: SubnetHoldersDegradedSchema.optional(),
  })
  .passthrough();
export type SubnetHoldersArtifact = z.infer<typeof SubnetHoldersArtifactSchema>;
export const SubnetHoldersResponseSchema = successEnvelopeSchema(
  SubnetHoldersArtifactSchema,
);
// The ceiling is read from src/route-limits.ts rather than restated, so the
// published `maximum` cannot drift from what the handler enforces (#9127).
export const SubnetHoldersQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(SUBNET_HOLDERS_LIMIT_MAX)
      .optional(),
  })
  .strict();
