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
import { successEnvelopeSchema } from "../envelope.ts";

export const ConcentrationScorecardSchema = z
  .object({
    holders: z.int(),
    total: z.number().nullable(),
    gini: z.number().nullable(),
    hhi: z.number().nullable(),
    hhi_normalized: z.number().nullable(),
    nakamoto_coefficient: z.int(),
    top_1pct_share: z.number().nullable(),
    top_5pct_share: z.number().nullable(),
    top_10pct_share: z.number().nullable(),
    top_20pct_share: z.number().nullable(),
    entropy: z.number().nullable(),
    entropy_normalized: z.number().nullable(),
  })
  .strict();
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
        "This domain's member subnets' stake, TAO-priced through each subnet's own alpha_price_tao from the economics tier (#9051). A member with no resolvable price is excluded and reported in unpriced_stake_alpha.",
      ),
    unpriced_stake_alpha: z
      .number()
      .nullable()
      .describe(
        "The alpha the TAO-priced totals do NOT cover (#9051): raw cross-subnet alpha on subnets with no resolvable alpha_price_tao. 0 when every membership priced.",
      ),
    total_emission_share: z.number().nullable(),
    emission_concentration: ConcentrationScorecardSchema.nullable(),
  })
  .strict();
export type DomainSummaryArtifact = z.infer<typeof DomainSummaryArtifactSchema>;
export const DomainSummaryResponseSchema = successEnvelopeSchema(
  DomainSummaryArtifactSchema,
);

export const DomainsArtifactSchema = z
  .object({
    schema_version: z.int(),
    domain_count: z.int().min(0),
    domains: z.array(DomainSummaryArtifactSchema),
  })
  .strict();
export type DomainsArtifact = z.infer<typeof DomainsArtifactSchema>;
export const DomainsResponseSchema = successEnvelopeSchema(
  DomainsArtifactSchema,
);

// Neither route takes query params (validateQueryParams(url, []) in both
// handleDomains and handleDomainSummary -- domain-summary's `tag` is a path
// segment, not a query param).
export const DomainsQuerySchema = z.object({}).strict();
export type DomainsQuery = z.infer<typeof DomainsQuerySchema>;
