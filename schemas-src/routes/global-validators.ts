// GET /api/v1/validators (types-epic B batch 7, #8061). Live neurons D1-tier
// data -- no static file. Modeled from src/metagraph-neurons.ts's
// buildGlobalValidators(), cross-checked against the hand-edited
// GlobalValidatorsArtifact component it replaces.
//
// ColdkeyIdentitySchema is exported (not registered) so validator-detail.ts
// and compare-validators.ts can reuse it directly -- ColdkeyIdentity's 3
// hand-edited referrers (GlobalValidatorEntry, ValidatorDetailArtifact,
// CompareValidatorEntry) are ALL converted together in this batch (verified
// via repo-wide $ref grep), so the hand-edited component key becomes fully
// orphaned. GlobalValidatorSubnet is intentionally NOT registered either --
// GlobalValidatorEntry is its only referrer -- so that hand-edited key also
// becomes fully orphaned.
import { z } from "zod";

/** This route's own vocabulary, owned here so its MCP tool imports rather than restates it (#9799). */
export const GLOBAL_VALIDATORS_VALIDATOR_SORTS_VALUES = [
  "avg_validator_trust",
  "max_validator_trust",
  "stake_dominance",
  "subnet_count",
  "total_emission",
  "total_stake",
  "uid_count",
] as const;

export const ColdkeyIdentitySchema = z
  .object({
    has_identity: z.boolean(),
    name: z.string().nullable(),
    url: z.url().nullable(),
    github: z.url().nullable(),
    image: z.url().nullable(),
    discord: z.string().max(200).nullable(),
    description: z.string().nullable(),
    additional: z.string().nullable(),
    captured_at: z.string().nullable(),
  })
  .strict()
  .describe(
    "Self-reported on-chain identity (SubtensorModule::set_identity) for a `coldkey`.",
  );

const GlobalValidatorSubnetSchema = z
  .object({
    netuid: z.int().min(0),
    uid: z.int().min(0),
    stake_tao: z.number().min(0),
    emission_tao: z.number().min(0),
    validator_trust: z.number().nullable(),
  })
  .strict();

export const GlobalValidatorEntrySchema = z
  .object({
    hotkey: z.string(),
    featured: z.boolean(),
    coldkey: z.string().nullable(),
    coldkey_identity: ColdkeyIdentitySchema.nullable(),
    coldkey_count: z.int().min(0),
    subnet_count: z.int().min(0),
    uid_count: z.int().min(0),
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
        "Realized return on staked capital over a NOMINAL 1-day window. The interval is not exact: the baseline is the newest neuron_daily snapshot within a 2-day tolerance of the target date (#8837), so this can measure 1, 2 or 3 elapsed days. Read realized_return_1d_as_of for the day it actually resolved to before annualizing or plotting day-over-day (#9885).",
      ),
    realized_return_1d_as_of: z
      .string()
      .nullable()
      .describe(
        "The neuron_daily snapshot_date the 1-day baseline resolved to, or null when there is no baseline (in which case realized_return_1d is null too). Subtract it from the response stamp for the true elapsed interval.",
      ),
    realized_return_1w: z
      .number()
      .nullable()
      .describe(
        "Realized return over a NOMINAL 7-day window; the same 2-day tolerance makes the true interval 5-9 days. See realized_return_1w_as_of (#9885).",
      ),
    realized_return_1w_as_of: z
      .string()
      .nullable()
      .describe(
        "The neuron_daily snapshot_date the 7-day baseline resolved to, or null when realized_return_1w is null.",
      ),
    realized_return_1m: z
      .number()
      .nullable()
      .describe(
        "Realized return over a NOMINAL 30-day window; the same 2-day tolerance makes the true interval 28-32 days. See realized_return_1m_as_of (#9885).",
      ),
    realized_return_1m_as_of: z
      .string()
      .nullable()
      .describe(
        "The neuron_daily snapshot_date the 30-day baseline resolved to, or null when realized_return_1m is null.",
      ),
    stake_dominance: z.number().min(0).max(1).nullable(),
    avg_validator_trust: z.number().nullable(),
    max_validator_trust: z.number().nullable(),
    latest_captured_at: z.string().nullable(),
    latest_block_number: z.int().min(0).nullable(),
    subnets: z.array(GlobalValidatorSubnetSchema).max(10),
  })
  .strict();

export const GlobalValidatorsArtifactSchema = z
  .object({
    schema_version: z.int(),
    sort: z.enum(GLOBAL_VALIDATORS_VALIDATOR_SORTS_VALUES),
    // #8251: 2000 cap (was 100) so the directory page can fetch the full
    // validator set in one request -- mirrors GLOBAL_VALIDATOR_LIMIT_MAX in
    // src/metagraph-neurons.ts.
    limit: z.int().min(1).max(2000),
    block_number: z.int().min(0).nullable(),
    captured_at: z.string().nullable(),
    validator_count: z.int().min(0),
    validators: z.array(GlobalValidatorEntrySchema),
  })
  .passthrough();
export type GlobalValidatorsArtifact = z.infer<
  typeof GlobalValidatorsArtifactSchema
>;
