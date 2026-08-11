// GET /api/v1/domains, GET /api/v1/domains/{tag}/summary (types-epic B
// batch 1, #8055). Live registry+economics rollups -- no static file.
// Modeled from src/domain-summary.ts's DomainSummaryResult/
// DomainOverviewResult interfaces and src/concentration.ts's
// ConcentrationScorecard interface + TOP_PERCENTILES ([1,5,10,20], resolved
// to concrete top_Npct_share keys -- computeConcentration() always sets
// every field, mirrors the pilot batch's stake-quote precedent for a
// function that returns one fixed shape or null), cross-checked against the
// hand-edited DomainSummaryArtifact/DomainsArtifact components they
// replace.
import { z } from "zod";
import { ConcentrationMetricsSchema } from "../shared.ts";

/**
 * The registry's ONE concentration vocabulary, at this route's strength.
 *
 * Twelve measures, declared twice until #10790: `ConcentrationMetricsSchema`
 * (shared.ts, and a registered public component) and a field-for-field copy
 * here. Derived rather than re-listed, with the two ways this route is
 * genuinely stronger stated instead of restated -- its producer returns one
 * fixed shape or null, so every measure is present, and it always computes a
 * holder count and a Nakamoto coefficient.
 */
export const ConcentrationScorecardSchema = ConcentrationMetricsSchema.unwrap()
  .required()
  .extend({
    holders: z.int(),
    nakamoto_coefficient: z.int(),
  })
  .describe(
    "Concentration metrics over a value distribution -- Gini, HHI (raw + holder-count-normalized), Nakamoto coefficient, top-percentile shares, and Shannon entropy.",
  );
export type ConcentrationScorecard = z.infer<
  typeof ConcentrationScorecardSchema
>;

export const DomainSummaryArtifactSchema = z
  .object({
    schema_version: z.int(),
    domain: z.string(),
    subnet_count: z.int().min(0),
    netuids: z.array(z.int().min(0)),
    total_stake_tao: z
      .number()
      .nullable()
      .describe(
        "This domain's member subnets' stake, TAO-priced through each subnet's own alpha_price_tao from the economics tier (#9051), rather than a sum of incomparable per-subnet alpha tokens. The economics tier carries a price for every subnet, so a member without one is a data defect and is excluded from the total.",
      ),
    total_emission_share: z.number().nullable(),
    emission_concentration: ConcentrationScorecardSchema.nullable().describe(
      "Within-domain emission concentration scorecard; null when the domain has no members. Declared Float until #9889 — the route has served the full 12-key scorecard for long enough that the scalar coerced to null on every domain, which this type's own comment then read as 'no members'.",
    ),
  })
  .strict()
  .describe(
    "One domain/capability tag's rollup (#6989). Mirrors GET /api/v1/domains/{tag}/summary.",
  );
export type DomainSummaryArtifact = z.infer<typeof DomainSummaryArtifactSchema>;

export const DomainsArtifactSchema = z
  .object({
    schema_version: z.int(),
    domain_count: z.int().min(0),
    domains: z.array(DomainSummaryArtifactSchema),
  })
  .strict()
  .describe(
    "The per-domain rollup overview across the fixed capability taxonomy (#6989). Mirrors GET /api/v1/domains.",
  );
export type DomainsArtifact = z.infer<typeof DomainsArtifactSchema>;
