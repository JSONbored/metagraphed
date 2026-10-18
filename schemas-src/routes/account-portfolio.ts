// GET /api/v1/accounts/{ss58}/portfolio (types-epic B batch 4, #8058). Live
// neurons store-tier data -- no static file. Modeled from
// src/account-portfolio.ts's buildAccountPortfolio(). Capital and yield keys
// remain as nullable compatibility fields because metagraph voting weight does
// not establish independent principal.
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
      .nullable()
      .describe(
        "Deprecated compatibility field; always null. The source records metagraph voting weight (alpha + tao_weight * root), not an independently measured alpha position or principal. A subnet identity does not establish token quantities.",
      )
      .meta({ deprecated: true }),
    emission_alpha: z
      .number()
      .describe(
        "This row's emission in the subnet named by the sibling `netuid`, alpha-denominated outside root. netuid 0 (root) is genuine TAO. The RATE PERIOD is one TEMPO -- the subnet's `tempo` hyperparameter, 360 blocks (~20 tempos/day) on effectively every subnet -- not one day: multiply by tempos/day before deriving a daily figure. Renamed from `emission_tao` in #10514 -- see that sibling for why this one payload could not keep the on-chain name.",
      ),
    rank: z.number().nullable(),
    trust: z.number().nullable(),
    incentive: z.number().nullable(),
    dividends: z.number().nullable(),
    yield: z
      .number()
      .nullable()
      .describe(
        "Deprecated compatibility field; always null. Voting weight is not an investment-principal denominator; null is unavailable, never zero yield.",
      )
      .meta({ deprecated: true }),
  })
  .strict()
  .describe(
    "One hotkey membership with observed scores and native emission, in netuid/uid order. Capital and yield are unavailable.",
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
      .nullable()
      .describe(
        "Deprecated compatibility field; always null. Pricing or summing metagraph voting weight cannot establish independent principal or holdings value. Null is unavailable, including for an empty response, never a zero holding.",
      )
      .meta({ deprecated: true }),
    total_emission_tao: z
      .number()
      .describe(
        "Cross-subnet total in genuine TAO (#9051): each membership converts through its own subnet's latest SPOT price -- tao_in_pool_tao / alpha_in_pool from that subnet's newest snapshot, root at 1:1 -- before summing, so this is a real TAO value rather than a sum of incomparable per-subnet alpha tokens. Prices are complete by construction (the economics tier carries a price for every subnet, and subnet_snapshots is written from it); a membership whose subnet has no price row is excluded, which under-reports rather than mis-denominates. Marked at SPOT, not at alpha_price_tao: that field is the chain's MOVING price (#9408), and a lagging average is the wrong mark for what a position is worth -- measured -1.29% against spot on netuid 64 for 2026-08-03. Prices still come from the daily subnet_snapshots rollup, so the valuation can lag up to ~24h behind the live economics tier; the lag is the rollup's, no longer the average's.",
      ),
    overall_yield: z
      .number()
      .nullable()
      .describe(
        "Deprecated compatibility field; always null because independently measured investment principal is unavailable. Voting weight cannot establish an investment return.",
      )
      .meta({ deprecated: true }),
    // Keep the existing nullable compatibility key; source voting weight
    // cannot establish holdings-value concentration even with memberships.
    stake_concentration: ConcentrationMetricsSchema.nullable().describe(
      "Always null: the source cannot establish holdings-value concentration from metagraph voting weight.",
    ),
    positions: z.array(PortfolioPositionSchema),
  })
  .strict()
  .describe(
    "One hotkey's cross-subnet memberships, observed scores and emission. Capital, concentration and investment yield remain unavailable without independently measured principal. Mirrors GET /api/v1/accounts/{ss58}/portfolio.",
  );
export type AccountPortfolioArtifact = z.infer<
  typeof AccountPortfolioArtifactSchema
>;
