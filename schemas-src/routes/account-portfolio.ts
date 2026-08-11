// GET /api/v1/accounts/{ss58}/portfolio (types-epic B batch 4, #8058). Live
// neurons D1-tier data -- no static file. Modeled from
// src/account-portfolio.ts's buildAccountPortfolio() (which reuses
// src/concentration.ts's computeConcentration() -- the exact function
// ConcentrationMetricsSchema in shared.ts models, added by types-epic B
// batch 3 / #8057), cross-checked against the hand-edited
// AccountPortfolioArtifact component it replaces.
//
// Bucket (c) note: the hand-edited component wrapped `stake_concentration`
// as `anyOf: [$ref ConcentrationMetrics, null]`; the generated schema is a
// bare `$ref` because ConcentrationMetricsSchema (shared.ts) is already
// `.nullable()` at its own root -- same effective nullability, different
// JSON Schema encoding of it. PortfolioPosition's `positions[]` items are
// `.strict()` here (additionalProperties: false) vs the hand-edited
// `additionalProperties: true` -- buildAccountPortfolio() always emits
// exactly these 11 fields per position, never more, so tightening to strict
// matches reality without narrowing what the real builder ever returns.
//
// PortfolioPosition is intentionally NOT registered as a shared component --
// AccountPortfolioArtifact is its only referrer anywhere in schemas/
// components/*.schema.json (verified via repo-wide $ref grep), so the
// hand-edited component key becomes fully orphaned.
import { z } from "zod";
import { ConcentrationMetricsSchema } from "../shared.ts";

const PortfolioPositionSchema = z
  .object({
    netuid: z.int().min(0),
    uid: z.int().nullable(),
    role: z.enum(["validator", "miner"]),
    active: z.boolean(),
    stake_alpha: z
      .number()
      .describe(
        "This row's stake in the subnet named by the sibling `netuid`. ALPHA for non-root subnets -- a non-root neuron's stake is that subnet's own alpha token, not TAO (#2550); netuid 0 (root) stake is genuine TAO. Comparable within one subnet, NEVER summable across subnets. Renamed from `stake_tao` in #10514: #8945 left the on-chain column name in place on the reasoning that the denominating `netuid` sits in the same object, which holds -- except here, where a PRICED `total_stake_tao` sits in the same object too, and two fields sharing the `_tao` suffix while carrying different units is a trap no description can undo. The total is the one that is really TAO.",
      ),
    emission_alpha: z
      .number()
      .describe(
        "This row's emission in the subnet named by the sibling `netuid`, alpha-denominated for the same reason as the sibling stake field (#2550). netuid 0 (root) is genuine TAO. Renamed from `emission_tao` in #10514 -- see that sibling for why this one payload could not keep the on-chain name.",
      ),
    rank: z.number().nullable(),
    trust: z.number().nullable(),
    incentive: z.number().nullable(),
    dividends: z.number().nullable(),
    yield: z
      .number()
      .nullable()
      .describe("Emission over stake for this position; null when stake is 0."),
  })
  .strict()
  .describe(
    "One subnet position in a wallet's portfolio, ranked biggest-stake-first.",
  );

export const AccountPortfolioArtifactSchema = z
  .object({
    schema_version: z.int(),
    ss58: z.string(),
    captured_at: z.string().nullable(),
    subnet_count: z.int().min(0),
    position_count: z.int().min(0),
    validator_count: z.int().min(0),
    miner_count: z.int().min(0),
    total_stake_tao: z
      .number()
      .describe(
        "Cross-subnet total in genuine TAO (#9051): each membership converts through its own subnet's latest SPOT price -- tao_in_pool_tao / alpha_in_pool from that subnet's newest snapshot, root at 1:1 -- before summing, so this is a real TAO value rather than a sum of incomparable per-subnet alpha tokens. Prices are complete by construction (the economics tier carries a price for every subnet, and subnet_snapshots is written from it); a membership whose subnet has no price row is excluded, which under-reports rather than mis-denominates. Marked at SPOT, not at alpha_price_tao: that field is the chain's MOVING price (#9408), and a lagging average is the wrong mark for what a position is worth -- measured -1.29% against spot on netuid 64 for 2026-08-03. Prices still come from the daily subnet_snapshots rollup, so the valuation can lag up to ~24h behind the live economics tier; the lag is the rollup's, no longer the average's.",
      ),
    total_emission_tao: z
      .number()
      .describe(
        "Cross-subnet total in genuine TAO (#9051): each membership converts through its own subnet's latest SPOT price -- tao_in_pool_tao / alpha_in_pool from that subnet's newest snapshot, root at 1:1 -- before summing, so this is a real TAO value rather than a sum of incomparable per-subnet alpha tokens. Prices are complete by construction (the economics tier carries a price for every subnet, and subnet_snapshots is written from it); a membership whose subnet has no price row is excluded, which under-reports rather than mis-denominates. Marked at SPOT, not at alpha_price_tao: that field is the chain's MOVING price (#9408), and a lagging average is the wrong mark for what a position is worth -- measured -1.29% against spot on netuid 64 for 2026-08-03. Prices still come from the daily subnet_snapshots rollup, so the valuation can lag up to ~24h behind the live economics tier; the lag is the rollup's, no longer the average's.",
      ),
    overall_yield: z
      .number()
      .nullable()
      .describe(
        "Priced emission per priced stake -- both sides in TAO (#9051), so the ratio is dimensionally coherent. Null with no priceable stake.",
      ),
    stake_concentration: ConcentrationMetricsSchema.describe(
      "How concentrated the wallet's stake is across its subnets (Gini/HHI/etc); null with no positions.",
    ),
    positions: z.array(PortfolioPositionSchema),
  })
  .passthrough()
  .describe(
    "One wallet's cross-subnet neuron portfolio (#5702): every subnet where the hotkey is a registered neuron, plus wallet-level aggregates. Mirrors GET /api/v1/accounts/{ss58}/portfolio.",
  );
export type AccountPortfolioArtifact = z.infer<
  typeof AccountPortfolioArtifactSchema
>;
