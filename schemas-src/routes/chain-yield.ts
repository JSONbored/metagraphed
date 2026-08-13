// GET /api/v1/chain/yield (types-epic B batch 6, #8060). Live neurons
// store-tier data -- no static file. Modeled from src/chain-yield.ts's
// buildChainYield()/yieldDistribution(), cross-checked against the
// hand-edited ChainYieldArtifact component it replaces.
//
// YieldDistribution is intentionally NOT registered as a shared component --
// ChainYieldArtifact is its only referrer (verified via repo-wide $ref
// grep), so the hand-edited component key becomes fully orphaned.
import { z } from "zod";
import { distributionStatsSchema } from "../shared.ts";

/**
 * The shared count-and-spread summary, plus the one percentile this domain
 * reports that the others do not.
 *
 * #10790 collapsed that eight-key summary from four hand-written copies into
 * `distributionStatsSchema()`. This was a FIFTH copy and survived the collapse
 * for a single reason: it carries `p10`, so its key set is not equal to the
 * others', and the duplicate gate matches key sets exactly. A copy that has
 * gained a field stops looking like a copy at precisely the moment it has
 * started to drift.
 *
 * The eight shared fields were field-for-field identical to
 * `distributionStatsSchema(z.number())` at the point of collapse -- an
 * unbounded measure with unbounded percentiles -- so nothing published moves.
 */
const YieldDistributionSchema = distributionStatsSchema(z.number())
  .extend({ p10: z.number() })
  .describe(
    "Distribution of the per-neuron emission/stake return rate across the network.",
  )
  .nullable();

export const ChainYieldArtifactSchema = z
  .object({
    schema_version: z.int(),
    subnet_count: z
      .int()
      .min(0)
      .describe(
        "How many subnets the aggregate spans. Root (netuid 0) is NOT one of them and is excluded from every figure below (#9040): root stake is TAO, not a subnet alpha token.",
      ),
    neuron_count: z.int().min(0),
    validator_count: z.int().min(0).optional(),
    miner_count: z.int().min(0).optional(),
    captured_at: z.string().nullable().optional(),
    total_stake_alpha: z
      .number()
      .optional()
      .describe(
        "Sum of every neuron's stake across every NON-ROOT subnet. ALPHA, not TAO: a non-root neuron's stake is that subnet's alpha token, so this is a cross-subnet alpha count, not a TAO value (renamed from total_stake_tao in #8803). Root (netuid 0) is excluded because root stake is genuine TAO and would mix denominations into this sum (#9040). Use it as the denominator of the yields below, not as a TAO figure.",
      ),
    total_emission_alpha: z
      .number()
      .optional()
      .describe(
        "Sum of every neuron's emission across every NON-ROOT subnet, alpha-denominated for the same reason as total_stake_alpha and excluding root for the same reason (#8803, #9040). Alpha/alpha keeps the *_yield ratios below dimensionally valid.",
      ),
    network_yield: z.number().nullable(),
    validator_yield: z.number().nullable().optional(),
    miner_yield: z.number().nullable().optional(),
    distribution: YieldDistributionSchema,
  })
  .strict()
  .describe(
    "Network-wide emission-yield (return rate) card across every subnet's neurons. Aggregates are null on a cold store (schema-stable, never a GraphQL error). Mirrors GET /api/v1/chain/yield.",
  );
export type ChainYieldArtifact = z.infer<typeof ChainYieldArtifactSchema>;
