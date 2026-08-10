// GET /api/v1/subnets/{netuid}/revenue and GET /api/v1/chain/revenue-coverage
// (#10447).
//
// The served shape of src/revenue-coverage.ts. Two things the schema has to
// carry that a naive response would drop:
//
//   1. `coverage_ratio` and `subsidy_multiple` are NULLABLE, and null is the
//      normal case -- 126 of 128 subnets have no readable revenue figure. A
//      non-null type here would force a caller to read absent as zero, which
//      is the false claim this whole epic exists to avoid making at scale.
//   2. `provenance` is REQUIRED on every figure, so a consumer cannot read a
//      number without its evidence class. An agent that quotes a revenue
//      figure as fact because the response let it is the failure mode
//      #10439's ladder exists for.
import { z } from "zod";
import { ArtifactBaseSchema, successEnvelopeSchema } from "../envelope.ts";
import { FieldSourcesSchema } from "../shared.ts";

export const REVENUE_PROVENANCE_VALUES = [
  "chain-verified",
  "probe-derived",
  "operator-attested",
  "third-party-reported",
  "proxy-only",
  "none",
] as const;
export const RevenueProvenanceSchema = z.enum(REVENUE_PROVENANCE_VALUES);

export const CoverageBasisSchema = z
  .object({ tao: z.number(), usd: z.number() })
  .strict();

export const RevenueEmissionSchema = z
  .object({
    basis: z.literal("tao_total").meta({
      description:
        "SubnetTaoInEmission + SubnetExcessTao, the TAO the network directs into this subnet. Fully measured rather than reconstructed. The alternates are published beside it and never silently substituted.",
    }),
    tao: z.number(),
    usd: z.number(),
    alternates: z
      .object({
        alpha_out_priced: CoverageBasisSchema.nullable(),
        owner_take: CoverageBasisSchema,
      })
      .strict(),
  })
  .strict();

export const RevenueSourceSchema = z
  .object({
    surface_id: z.string(),
    provenance: RevenueProvenanceSchema,
    currency: z.string(),
    grain: z.string(),
    amount_usd: z.number().nullable().meta({
      description:
        "Null when the surface declares revenue but nothing has been read from it — an auth-gated endpoint, or a probe that has not run.",
    }),
    response_hash: z.string().nullable().optional(),
    observed_at: z.string().nullable().optional(),
  })
  .strict();

export const RevenueVerificationSchema = z
  .object({
    verified: z.boolean().meta({
      description:
        "False means the response is not defensible and must not be presented as fact. Mirrors the emission-pipeline convention.",
    }),
    checks: z.array(
      z
        .object({ name: z.string(), ok: z.boolean(), detail: z.string() })
        .strict(),
    ),
  })
  .strict();

export const SubnetRevenueSchema = z
  .object({
    netuid: z.int().min(0).max(65535),
    window_days: z.int().min(1),
    emission: RevenueEmissionSchema,
    revenue_usd: z.number().nullable().meta({
      description:
        "NULL means not observed. Never zero-by-default: a subnet that earned nothing and a subnet nobody has read are different facts.",
    }),
    provenance: RevenueProvenanceSchema,
    searched_at: z.string().nullable().optional(),
    coverage_ratio: z.number().nullable().meta({
      description:
        "revenue / emission. NULL whenever revenue_usd is null, which is the majority case. A client must render null as 'not observed', never as 0%.",
    }),
    subsidy_multiple: z.number().nullable().meta({
      description:
        "emission / revenue, the ecosystem's own phrasing. NULL when revenue is null OR zero — dividing by zero is undefined, not infinite, and Infinity would sort as the worst possible subsidy rather than as not-applicable.",
    }),
    sources: z.array(RevenueSourceSchema),
    verification: RevenueVerificationSchema,
  })
  .strict();

export const SubnetRevenueArtifactSchema = ArtifactBaseSchema.extend({
  netuid: z.int().min(0).max(65535),
  revenue: SubnetRevenueSchema,
  field_sources: FieldSourcesSchema,
}).describe(
  "One subnet's external revenue against the TAO the network emits to it. coverage_ratio and subsidy_multiple are NULL whenever revenue is not observed, which is the normal case — 127 of 129 subnets publish no readable figure, and rendering them as 0% covered would be a false claim about each of them. Mirrors GET /api/v1/subnets/{netuid}/revenue.",
);
export type SubnetRevenueArtifact = z.infer<typeof SubnetRevenueArtifactSchema>;

export const ChainRevenueCoverageArtifactSchema = ArtifactBaseSchema.extend({
  window_days: z.int().min(1),
  observed_count: z.int().min(0).meta({
    description:
      "How many subnets have a readable revenue figure. Against subnet_count this is the honest headline, stated rather than left to be inferred from nulls.",
  }),
  subnet_count: z.int().min(0),
  subnets: z.array(SubnetRevenueSchema),
}).describe(
  "Every subnet's revenue coverage in one response. Subnets with no observed revenue are INCLUDED with null ratios rather than dropped, because omitting them would make the covered set look like the whole network. Mirrors GET /api/v1/chain/revenue-coverage.",
);
export type ChainRevenueCoverageArtifact = z.infer<
  typeof ChainRevenueCoverageArtifactSchema
>;

export const SubnetRevenueResponseSchema = successEnvelopeSchema(
  SubnetRevenueArtifactSchema,
);
export const ChainRevenueCoverageResponseSchema = successEnvelopeSchema(
  ChainRevenueCoverageArtifactSchema,
);
