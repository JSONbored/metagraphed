// GET /api/v1/chain/emission-pipeline (#8744) — the v440 decomposition.
//
// Shape mirrors src/emission-decomposition.ts's EmissionDecomposition exactly;
// the module is the source of truth and this is its contract projection.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";
import { ChainStateSchema, FieldSourcesSchema } from "../shared.ts";

/** A fraction of block emission. Null where stage 0 excluded the subnet. */
const ShareSchema = z.number().nullable();

export const SubnetEmissionDecompositionSchema = z
  .object({
    netuid: z.int().min(0),
    // Non-null means the subnet took no part in stage 1 at all, and every
    // downstream share is null rather than 0 -- "not in the distribution" is
    // not "in it with nothing".
    ineligible_reason: z
      .enum([
        "root",
        "never_emitted",
        "subtoken_disabled",
        "registration_closed",
      ])
      .nullable(),
    /** Stage 1, the published `emission_share` (ADR 0023 decision 1). */
    emission_share: ShareSchema,
    /** Stage 2 input. A FRACTION in [0,1] (U96F32), never an amount. */
    miner_burned: z.number().min(0).max(1),
    weighted_share: ShareSchema,
    gated_share: ShareSchema,
    // PUBLISHED, NOT INFERRED. A subnet far enough below the bar has its gated
    // share underflow to exactly 0, so an enabled-but-deeply-gated subnet and
    // a disabled one both read final_share: 0. The flag is the only thing that
    // separates them.
    emission_enabled: z.boolean(),
    final_share: ShareSchema,
    /** `gated_share - weighted_share`. Sums to ~0: the gate never withholds. */
    gate_delta: ShareSchema,
    /** `weighted_share / theta`. Null when the bar is unset (gate disabled). */
    distance_to_bar: ShareSchema,
    tao_in_emission: z.number().nullable(),
    excess_tao: z.number().nullable(),
    tao_total: z.number().nullable(),
    // Null rather than NaN for a zero-intake subnet: 0/0 is not a fraction,
    // and zero intake is a real state.
    liquidity_fraction: z.number().min(0).max(1).nullable(),
    alpha_in_emission: z.number().nullable(),
    alpha_out_emission: z.number().nullable(),
  })
  .strict();

/** One identity, reported whether it passed or failed. */
export const EmissionIdentityCheckSchema = z
  .object({
    name: z.string(),
    ok: z.boolean(),
    detail: z.string(),
  })
  .strict();

// The decomposition's own fields, split out from the artifact schema so the
// get_emission_pipeline MCP tool can mirror the REST contract field for field
// instead of re-declaring it (schemas-src/mcp-tools/get-emission-pipeline.ts).
// The MCP tool returns the projection alone, with none of ArtifactBase's
// envelope fields, so it needs the body without the extend -- and a second
// hand-kept copy of a 7-field shape is exactly how tri-surface parity rots.
export const EMISSION_PIPELINE_BODY = {
  // The artifact's own version, declared here rather than inherited from
  // ArtifactBaseSchema: this route is COMPUTED_LIVE with no static file, so it
  // has no `generated_at` to give -- same shape EconomicsTrendsArtifact and
  // CompareArtifact take for the same reason.
  schema_version: z.int(),
  chain_state: ChainStateSchema,
  block_emission_tao: z.number().nullable(),
  block_emission_halvings: z.int().min(0).nullable(),
  subnets: z.array(SubnetEmissionDecompositionSchema),
  aggregate: z
    .object({
      eligible_count: z.int().min(0),
      disabled_count: z.int().min(0),
      tao_in_emission: z.number(),
      excess_tao: z.number(),
      tao_total: z.number(),
      liquidity_fraction: z.number().min(0).max(1).nullable(),
      total_final_share: z.number(),
    })
    .strict(),
  // ADR 0023 decision 3, in band. `verified: false` means the identities did
  // not hold on THESE rows -- the response is not defensible and must not be
  // used, rather than being quietly served as if it were.
  verification: z
    .object({
      verified: z.boolean(),
      checks: z.array(EmissionIdentityCheckSchema),
      subnet_share_tolerance: z.number(),
      // A rao count, as a string: the tolerance is a bigint and a JSON number
      // is the wrong type for one.
      aggregate_tolerance_rao: z.string().regex(/^\d+$/),
    })
    .strict(),
  // Per-field kind + storage item, so a consumer cannot mistake OUR arithmetic
  // for something the chain published. The shape moved to ../shared.ts when
  // the network singletons started publishing the same map (#9078) -- same
  // record, same two kinds, just no longer declared in only one place.
  field_sources: FieldSourcesSchema,
} as const;

export const EmissionPipelineArtifactSchema = z
  .object(EMISSION_PIPELINE_BODY)
  .passthrough();
export type EmissionPipelineArtifact = z.infer<
  typeof EmissionPipelineArtifactSchema
>;

export const EmissionPipelineResponseSchema = successEnvelopeSchema(
  EmissionPipelineArtifactSchema,
);

export const EmissionPipelineQuerySchema = z
  .object({ netuid: z.int().min(0).optional() })
  .strict();
export type EmissionPipelineQuery = z.infer<typeof EmissionPipelineQuerySchema>;
