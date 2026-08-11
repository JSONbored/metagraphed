// GET /api/v1/chain/emission-pipeline (#8744) — the v440 decomposition.
//
// Shape mirrors src/emission-decomposition.ts's EmissionDecomposition exactly;
// the module is the source of truth and this is its contract projection.
import { z } from "zod";
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
      .nullable()
      .describe(
        "Non-null (root, never_emitted, subtoken_disabled, registration_closed) means the subnet took no part in stage 1, and every downstream share is null rather than 0 -- 'not in the distribution' is not 'in it with nothing'.",
      ),
    /**
     * `SubnetMovingPrice` (I96F32) -- the EMA of the subnet's alpha price and
     * stage 1's raw input, in TAO.
     *
     * Published because it is the quantity the runtime compares when deciding
     * which subnet to deregister, and one subnet leaves every time a new one
     * registers (#10285). `emission_share` normalizes it away, so a caller
     * cannot recover it from anything else served here.
     *
     * Null for a subnet with no positive moving price -- root and the
     * never-emitted set.
     */
    moving_price: z
      .number()
      .nullable()
      .optional()
      .describe(
        "SubtensorModule.SubnetMovingPrice in TAO -- the EMA of the subnet's alpha price and stage 1's raw input. Published unnormalized because it is the quantity the runtime compares when deciding which subnet to deregister; emission_share divides it by the sum across subnets, so a caller cannot recover it from anything else here. Null for a subnet with no positive moving price (root, and the never-emitted set).",
      ),
    /** Stage 1, the published `emission_share` (ADR 0023 decision 1). */
    emission_share: ShareSchema.describe(
      "Stage 1, the published emission_share (ADR 0023 decision 1) -- the PRICE share, not the share of TAO received.",
    ),
    /** Stage 2 input. A FRACTION in [0,1] (U96F32), never an amount. */
    miner_burned: z
      .number()
      .min(0)
      .max(1)
      .describe("Stage 2 input. A FRACTION in [0,1], never an amount."),
    weighted_share: ShareSchema,
    gated_share: ShareSchema,
    // PUBLISHED, NOT INFERRED. A subnet far enough below the bar has its gated
    // share underflow to exactly 0, so an enabled-but-deeply-gated subnet and
    // a disabled one both read final_share: 0. The flag is the only thing that
    // separates them.
    emission_enabled: z
      .boolean()
      .describe(
        "PUBLISHED, NOT INFERRED. A subnet far enough below the bar has its gated share underflow to exactly 0, so an enabled-but-deeply-gated subnet and a disabled one both read final_share: 0 -- this flag is the only thing that separates them.",
      ),
    final_share: ShareSchema,
    /** `gated_share - weighted_share`. Sums to ~0: the gate never withholds. */
    gate_delta: ShareSchema.describe(
      "gated_share - weighted_share. Sums to ~0 across the network: the gate redistributes, it never withholds.",
    ),
    /** `weighted_share / theta`. Null when the bar is unset (gate disabled). */
    distance_to_bar: ShareSchema.describe(
      "weighted_share / theta. Null when the bar is unset.",
    ),
    tao_in_emission: z
      .number()
      .nullable()
      .describe(
        "Stage 8, measured: the TAO injected into the subnet's pool this block.",
      ),
    excess_tao: z
      .number()
      .nullable()
      .describe(
        "Stage 7, measured: the TAO that reached the subnet by chain buys instead.",
      ),
    tao_total: z
      .number()
      .nullable()
      .describe(
        "Their sum -- the subnet's whole TAO intake this block. Null unless both channels were actually read.",
      ),
    // Null rather than NaN for a zero-intake subnet: 0/0 is not a fraction,
    // and zero intake is a real state.
    liquidity_fraction: z
      .number()
      .min(0)
      .max(1)
      .nullable()
      .describe(
        "tao_in_emission / tao_total, the headline per-subnet number. Null rather than NaN for a zero-intake subnet: 0/0 is not a fraction, and zero intake is a real state.",
      ),
    alpha_in_emission: z.number().nullable(),
    alpha_out_emission: z.number().nullable(),
  })
  .strict()
  .describe(
    "One subnet's path through stages 0-8. Every share is a fraction of block emission, null where stage 0 excluded the subnet from the distribution entirely.",
  );

/** One identity, reported whether it passed or failed. */
export const EmissionIdentityCheckSchema = z
  .object({
    name: z.string(),
    ok: z.boolean(),
    detail: z.string(),
  })
  .strict()
  .describe("One identity, reported whether it passed or failed.");

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
  chain_state: ChainStateSchema.describe(
    "The block every input below was pinned to. Required: without it nothing here can be verified.",
  ),
  block_emission_tao: z
    .number()
    .nullable()
    .describe(
      "Block emission derived from TotalIssuance at that block, never read from the stale BlockEmission storage item.",
    ),
  block_emission_halvings: z.int().min(0).nullable(),
  subnets: z.array(SubnetEmissionDecompositionSchema),
  // Present only when the caller narrowed the list with `limit`/`fields`
  // (#9720), so today's body is byte-for-byte unchanged for everyone else.
  // Published when they DO narrow it, because otherwise a 20-row page and a
  // network that really has 20 subnets are the same response.
  //
  // The row schema above continues to describe the UNPROJECTED row: a `fields`
  // projection returns a subset of these same keys, and this follows the
  // convention /api/v1/economics already set rather than weakening the contract
  // for every caller who does not project.
  matched_subnet_count: z.int().min(0).optional(),
  returned_subnet_count: z.int().min(0).optional(),
  aggregate: z
    .object({
      eligible_count: z.int().min(0),
      disabled_count: z.int().min(0),
      tao_in_emission: z.number(),
      excess_tao: z.number(),
      tao_total: z.number(),
      liquidity_fraction: z
        .number()
        .min(0)
        .max(1)
        .nullable()
        .describe(
          "The network split nobody else publishes: pool injection vs chain buys.",
        ),
      total_final_share: z
        .number()
        .describe(
          "Sum of final_share. 1.0 to float precision, or the surface is broken.",
        ),
    })
    .strict()
    .describe(
      "Network-wide totals across every row in the capture -- unchanged by the netuid argument, which narrows the per-subnet rows only.",
    ),
  // ADR 0023 decision 3, in band. `verified: false` means the identities did
  // not hold on THESE rows -- the response is not defensible and must not be
  // used, rather than being quietly served as if it were.
  verification: z
    .object({
      verified: z
        .boolean()
        .describe(
          "False means at least one identity did not hold on these rows: the response is not defensible and must not be used.",
        ),
      checks: z.array(EmissionIdentityCheckSchema),
      subnet_share_tolerance: z.number(),
      // A rao count, as a string: the tolerance is a bigint and a JSON number
      // is the wrong type for one.
      aggregate_tolerance_rao: z
        .string()
        .regex(/^\d+$/)
        .describe(
          "A rao count as a string -- the tolerance is a bigint, and a JSON number is the wrong type for one.",
        ),
    })
    .strict()
    .describe(
      "The four identities, evaluated on the rows being served rather than read from a stored flag -- a stored flag can be green while THIS response is broken, and it can go stale. ADR 0023 decision 3.",
    ),
  // Per-field kind + storage item, so a consumer cannot mistake OUR arithmetic
  // for something the chain published. The shape moved to ../shared.ts when
  // the network singletons started publishing the same map (#9078) -- same
  // record, same two kinds, just no longer declared in only one place.
  field_sources: FieldSourcesSchema,
} as const;

export const EmissionPipelineArtifactSchema = z
  .object(EMISSION_PIPELINE_BODY)
  .strict()
  .describe(
    "The v440 emission pipeline replayed over one pinned block (#8744) -- the per-subnet share decomposition, the network aggregate, and the identity checks evaluated on the rows being served.",
  );
export type EmissionPipelineArtifact = z.infer<
  typeof EmissionPipelineArtifactSchema
>;
