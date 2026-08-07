// GET /api/v1/chain/concentration/subnets (#9717). Live neurons D1-tier data --
// no static file, the same read its /chain/concentration sibling performs, kept
// grouped by netuid instead of collapsed into one aggregate.
//
// The row is a FLATTENED scorecard rather than the nested ConcentrationMetrics
// block the sibling uses, and deliberately so: this route serves ONE lens per
// response so that a caller can sort and project it. `?sort=gini` acting on
// `row.gini` is the whole point; `row.emission.gini` would need a path syntax
// no other list surface here has.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";

const CONCENTRATION_LENSES = [
  "emission",
  "stake",
  "entity_emission",
  "entity_stake",
  "validator_stake",
] as const;

const CONCENTRATION_RANKING_SORTS = [
  "nakamoto_coefficient",
  "gini",
  "holders",
  "top_1pct_share",
  "total",
  "netuid",
] as const;

export const ChainConcentrationSubnetsQuerySchema = z
  .object({
    lens: z.enum(CONCENTRATION_LENSES).optional(),
    sort: z.enum(CONCENTRATION_RANKING_SORTS).optional(),
    order: z.enum(["asc", "desc"]).optional(),
    limit: z.int().min(1).max(512).optional(),
  })
  .strict();
export type ChainConcentrationSubnetsQuery = z.infer<
  typeof ChainConcentrationSubnetsQuerySchema
>;

// Every metric is nullable together: a subnet whose chosen lens has no positive
// distribution carries nulls across the board and says so via `unmeasured`,
// rather than carrying zeros that would read as a perfectly equal subnet.
export const SubnetConcentrationRowSchema = z
  .object({
    netuid: z.int().min(0),
    neuron_count: z.int().min(0),
    entity_count: z.int().min(0),
    uids_per_entity: z.number().nullable(),
    holders: z.int().min(0).nullable(),
    total: z.number().nullable(),
    gini: z.number().nullable(),
    hhi: z.number().nullable(),
    hhi_normalized: z.number().nullable(),
    nakamoto_coefficient: z.int().min(0).nullable(),
    top_1pct_share: z.number().nullable(),
    top_5pct_share: z.number().nullable(),
    top_10pct_share: z.number().nullable(),
    top_20pct_share: z.number().nullable(),
    entropy: z.number().nullable(),
    entropy_normalized: z.number().nullable(),
    unmeasured: z.boolean(),
  })
  .strict();

export const ChainConcentrationSubnetsArtifactSchema = z
  .object({
    schema_version: z.int(),
    lens: z.enum(CONCENTRATION_LENSES),
    sort: z.enum(CONCENTRATION_RANKING_SORTS),
    order: z.enum(["asc", "desc"]),
    subnet_count: z.int().min(0),
    measured_subnet_count: z.int().min(0),
    returned: z.int().min(0),
    limit: z.int().min(1),
    neuron_count: z.int().min(0),
    captured_at: z.string().nullable(),
    // Dimension-free facts only. A median of a ratio compares across subnets;
    // a SUM of per-subnet alpha does not, because each subnet's alpha is a
    // different token -- the rule /chain/holders already states.
    network: z
      .object({
        median_gini: z.number().nullable(),
        median_nakamoto_coefficient: z.number().nullable(),
        median_top_1pct_share: z.number().nullable(),
        single_holder_subnet_count: z.int().min(0),
      })
      .strict(),
    subnets: z.array(SubnetConcentrationRowSchema),
  })
  .passthrough();
export type ChainConcentrationSubnetsArtifact = z.infer<
  typeof ChainConcentrationSubnetsArtifactSchema
>;
export const ChainConcentrationSubnetsResponseSchema = successEnvelopeSchema(
  ChainConcentrationSubnetsArtifactSchema,
);
