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
import { successEnvelopeSchema } from "../envelope.ts";
import { ConcentrationMetricsSchema } from "../shared.ts";

const PortfolioPositionSchema = z
  .object({
    netuid: z.int().min(0),
    uid: z.int().nullable(),
    role: z.enum(["validator", "miner"]),
    active: z.boolean(),
    stake_tao: z.number(),
    emission_tao: z.number(),
    rank: z.number().nullable(),
    trust: z.number().nullable(),
    incentive: z.number().nullable(),
    dividends: z.number().nullable(),
    yield: z.number().nullable(),
  })
  .strict();

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
        "Cross-subnet total in genuine TAO (#9051): each membership converts through its own subnet's latest alpha_price_tao (root at 1:1) before summing, so this is a real TAO value rather than a sum of incomparable per-subnet alpha tokens. Prices are complete by construction (the economics tier carries a price for every subnet, and subnet_snapshots is written from it); a membership whose subnet has no price row is excluded, which under-reports rather than mis-denominates. Prices come from the daily subnet_snapshots rollup, so the valuation can lag up to ~24h behind the live economics tier.",
      ),
    total_emission_tao: z
      .number()
      .describe(
        "Cross-subnet total in genuine TAO (#9051): each membership converts through its own subnet's latest alpha_price_tao (root at 1:1) before summing, so this is a real TAO value rather than a sum of incomparable per-subnet alpha tokens. Prices are complete by construction (the economics tier carries a price for every subnet, and subnet_snapshots is written from it); a membership whose subnet has no price row is excluded, which under-reports rather than mis-denominates. Prices come from the daily subnet_snapshots rollup, so the valuation can lag up to ~24h behind the live economics tier.",
      ),
    overall_yield: z
      .number()
      .nullable()
      .describe(
        "Priced emission per priced stake -- both sides in TAO (#9051), so the ratio is dimensionally coherent. Null with no priceable stake.",
      ),
    stake_concentration: ConcentrationMetricsSchema,
    positions: z.array(PortfolioPositionSchema),
  })
  .passthrough();
export type AccountPortfolioArtifact = z.infer<
  typeof AccountPortfolioArtifactSchema
>;
export const AccountPortfolioResponseSchema = successEnvelopeSchema(
  AccountPortfolioArtifactSchema,
);
export const AccountPortfolioQuerySchema = z.object({}).strict();
export type AccountPortfolioQuery = z.infer<typeof AccountPortfolioQuerySchema>;
