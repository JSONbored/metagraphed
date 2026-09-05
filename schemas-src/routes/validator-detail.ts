// GET /api/v1/validators/{hotkey} (types-epic B batch 7, #8061). Live
// neurons store-tier data -- no static file. Modeled from
// src/metagraph-neurons.ts's buildValidatorDetail() (which builds each
// subnets[] entry via formatNeuron(row) with no featuredHotkeys/
// immunityPeriod, so every neuron field is always set, never omitted),
// cross-checked against the hand-edited ValidatorDetailArtifact component
// it replaces. Reuses ColdkeyIdentitySchema from global-validators.ts.
//
// ValidatorDetailSubnetSchema is exported (not registered) so
// compare-validators.ts can reuse it for CompareValidatorEntry's
// subnet_context -- ValidatorDetailSubnet's only 2 hand-edited referrers
// (ValidatorDetailArtifact, CompareValidatorEntry) are both converted in
// this same batch (verified via repo-wide $ref grep), so the hand-edited
// component key becomes fully orphaned.
import { z } from "zod";
import { ColdkeyIdentitySchema } from "./global-validators.ts";

export const ValidatorDetailSubnetSchema = z
  .object({
    netuid: z.int().min(0),
    uid: z.int().min(0),
    hotkey: z.string().nullable(),
    coldkey: z.string().nullable(),
    active: z.boolean(),
    validator_permit: z.boolean(),
    rank: z.number().nullable(),
    trust: z.number().nullable(),
    validator_trust: z.number().nullable(),
    consensus: z.number().nullable(),
    incentive: z.number().nullable(),
    dividends: z.number().nullable(),
    emission_alpha: z
      .number()
      .nullable()
      .describe(
        "This row's emission on the subnet named by the sibling `netuid`. ALPHA for non-root subnets, genuine TAO on root (#2550). Renamed from `emission_tao` in #10514, because the entry's own `total_stake_tao` IS priced TAO and a shared `_tao` suffix across different units is a trap no description undoes.",
      ),
    stake_alpha: z
      .number()
      .nullable()
      .describe(
        "This row's stake on the subnet named by the sibling `netuid`. ALPHA for non-root subnets, genuine TAO on root (#2550). Renamed from `stake_tao` in #10514 -- see the sibling emission field. Never summable across subnets; the entry's priced total already did that conversion.",
      ),
    registered_at_block: z.int().min(0).nullable(),
    is_immunity_period: z.boolean(),
    axon: z.string().nullable(),
    axon_routable: z
      .boolean()
      .nullable()
      .describe(
        "Whether `axon` points somewhere on the public internet; null when there is no axon. Carried wherever `axon` is, because an unqualified endpoint implies reachability it may not have -- 5.3% of announced axons network-wide sit in RFC 5737, RFC 1918, loopback or 0.0.0.0/8 (#11373). Normally null here: not serving is the usual state for a validator.",
      ),
    take: z.number().nullable(),
  })
  .strict();

export const ValidatorDetailArtifactSchema = z
  .object({
    schema_version: z.int(),
    hotkey: z.string(),
    coldkey: z.string().nullable(),
    coldkey_identity: ColdkeyIdentitySchema.nullable(),
    coldkey_count: z.int().min(0),
    subnet_count: z.int().min(0),
    take: z.number().nullable(),
    total_stake_tao: z
      .number()
      .min(0)
      .describe(
        "Cross-subnet total in genuine TAO (#9051): each membership converts through its own subnet's latest SPOT price -- tao_in_pool_tao / alpha_in_pool from that subnet's newest snapshot, root at 1:1 -- before summing, so this is a real TAO value rather than a sum of incomparable per-subnet alpha tokens. Prices are complete by construction (the economics tier carries a price for every subnet, and subnet_snapshots is written from it); a membership whose subnet has no price row is excluded, which under-reports rather than mis-denominates. Marked at SPOT, not at alpha_price_tao: that field is the chain's MOVING price (#9408), and a lagging average is the wrong mark for what a position is worth -- measured -1.29% against spot on netuid 64 for 2026-08-03. Prices still come from the daily subnet_snapshots rollup, so the valuation can lag up to ~24h behind the live economics tier; the lag is the rollup's, no longer the average's.",
      ),
    root_stake_tao: z.number().min(0),
    alpha_stake_tao: z
      .number()
      .min(0)
      .describe(
        "The non-root leg of total_stake_tao, TAO-priced (#9051): the current market value of every alpha delegation the priced total covers. total_stake_tao = root_stake_tao + alpha_stake_tao, exactly.",
      ),
    total_emission_tao: z
      .number()
      .min(0)
      .describe(
        "Cross-subnet total in genuine TAO (#9051): each membership converts through its own subnet's latest SPOT price -- tao_in_pool_tao / alpha_in_pool from that subnet's newest snapshot, root at 1:1 -- before summing, so this is a real TAO value rather than a sum of incomparable per-subnet alpha tokens. Prices are complete by construction (the economics tier carries a price for every subnet, and subnet_snapshots is written from it); a membership whose subnet has no price row is excluded, which under-reports rather than mis-denominates. Marked at SPOT, not at alpha_price_tao: that field is the chain's MOVING price (#9408), and a lagging average is the wrong mark for what a position is worth -- measured -1.29% against spot on netuid 64 for 2026-08-03. Prices still come from the daily subnet_snapshots rollup, so the valuation can lag up to ~24h behind the live economics tier; the lag is the rollup's, no longer the average's.",
      ),
    nominator_count: z
      .int()
      .min(0)
      .nullable()
      .describe(
        "Distinct coldkeys with stake delegated to this validator's hotkey, from the poller's exhaustive SubtensorModule::Alpha scan (24h cadence). A validator absent from a FRESH scan reads as 0 rather than null: the pass covers the whole keyspace, so absence is a confirmed zero rather than a gap (#9314). null means the scan itself is stale or unavailable -- the count is unknown, not zero.",
      ),
    apy_estimate: z.number().min(0).nullable(),
    apy_estimate_eligible_subnet_count: z.int().min(0),
    realized_return_1d: z
      .number()
      .nullable()
      .describe(
        "Deprecated compatibility field; always null since #12015. Changes in delegated stake include deposits, withdrawals and price moves, so the former balance-change calculation did not measure investment return. Flow-neutral performance is unavailable; do not treat null as zero.",
      )
      .meta({ deprecated: true }),
    realized_return_1d_as_of: z
      .string()
      .nullable()
      .describe(
        "Deprecated compatibility field; always null with realized_return_1d. No investment-return measurement window is available.",
      )
      .meta({ deprecated: true }),
    realized_return_1w: z
      .number()
      .nullable()
      .describe(
        "Deprecated compatibility field; always null since #12015. Changes in delegated stake include deposits, withdrawals and price moves, so the former balance-change calculation did not measure investment return. Flow-neutral performance is unavailable; do not treat null as zero.",
      )
      .meta({ deprecated: true }),
    realized_return_1w_as_of: z
      .string()
      .nullable()
      .describe(
        "Deprecated compatibility field; always null with realized_return_1w. No investment-return measurement window is available.",
      )
      .meta({ deprecated: true }),
    realized_return_1m: z
      .number()
      .nullable()
      .describe(
        "Deprecated compatibility field; always null since #12015. Changes in delegated stake include deposits, withdrawals and price moves, so the former balance-change calculation did not measure investment return. Flow-neutral performance is unavailable; do not treat null as zero.",
      )
      .meta({ deprecated: true }),
    realized_return_1m_as_of: z
      .string()
      .nullable()
      .describe(
        "Deprecated compatibility field; always null with realized_return_1m. No investment-return measurement window is available.",
      )
      .meta({ deprecated: true }),
    avg_validator_trust: z.number().nullable(),
    max_validator_trust: z.number().nullable(),
    captured_at: z.string().nullable(),
    block_number: z.int().min(0).nullable(),
    subnets: z
      .array(ValidatorDetailSubnetSchema)
      .describe(
        "Per-subnet membership rows for this validator. The global leaderboard entry caps this at the top 10 by stake; the single-validator lookup carries every subnet.",
      ),
  })
  .strict();
export type ValidatorDetailArtifact = z.infer<
  typeof ValidatorDetailArtifactSchema
>;
