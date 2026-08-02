// Domain schemas shared across more than one pilot route (types-epic A,
// #7859) — kept out of envelope.ts (which is response-shape-only) and out of
// any single routes/*.ts file to avoid two independently hand-maintained,
// driftable copies of the same shape. Not part of the issue's literal file
// list; added because SubnetEconomics/SubnetStatus/CoverageLevel/etc. are
// each referenced by 2+ of the 5 pilot routes' real payloads.
//
// Derived from public/metagraph/openapi.json's components.schemas (built
// from src/contracts.ts, the canonical JSON-Schema contract), cross-checked
// against real handler output — see tests/zod-schemas.test.ts.
import { z } from "zod";

export const CoverageLevelSchema = z.enum([
  "native-only",
  "manifested",
  "probed",
]);
export type CoverageLevel = z.infer<typeof CoverageLevelSchema>;

// Chain network for the network-aware MCP tools (#8228). Same two values, and
// the same chain-name spelling, `call_rpc` already accepts — an agent should
// not have to learn that the RPC lane says "test" while a data lane says
// "testnet". Only the tools whose artifact is actually published per-network
// (list_subnets, get_subnet_detail) take this; everything else stays mainnet.
export const McpNetworkSchema = z.enum(["finney", "test"]);
export type McpNetwork = z.infer<typeof McpNetworkSchema>;

export const CurationLevelSchema = z.enum([
  "native",
  "candidate-discovered",
  "community-seeded",
  "machine-verified",
  "maintainer-reviewed",
  "adapter-backed",
]);
export type CurationLevel = z.infer<typeof CurationLevelSchema>;

export const SubnetStatusSchema = z.enum(["active", "inactive", "unknown"]);
export type SubnetStatus = z.infer<typeof SubnetStatusSchema>;

export const SubnetTypeSchema = z.enum(["root", "application"]);
export type SubnetType = z.infer<typeof SubnetTypeSchema>;

export const BittensorNetworkSchema = z.enum(["finney", "test", "local"]);
export type BittensorNetwork = z.infer<typeof BittensorNetworkSchema>;

export const HealthStatusSchema = z.enum([
  "ok",
  "degraded",
  "failed",
  "unknown",
]);
export type HealthStatus = z.infer<typeof HealthStatusSchema>;

export const PartnershipTierSchema = z.enum(["pilot"]);
export type PartnershipTier = z.infer<typeof PartnershipTierSchema>;

export const PartnershipMetadataSchema = z
  .object({
    // The hand-edited OpenAPI component declares format: "date" (plain
    // calendar date, e.g. "2026-07-04") -- z.iso.date() is the Zod
    // equivalent, verified against real registry/subnets/*.json partnership
    // data before adding this constraint.
    since: z.iso.date(),
    tier: PartnershipTierSchema,
    validator_hotkey: z.string().optional(),
  })
  .strict();
export type PartnershipMetadata = z.infer<typeof PartnershipMetadataSchema>;

// Per-subnet validator/economic metrics (src/contracts.ts's SubnetEconomics
// component) — the /api/v1/economics list item AND the optional `economics`
// field nested inside /api/v1/subnets/{netuid}'s SubnetDetailArtifact.
export const SubnetEconomicsSchema = z
  .object({
    alpha_fdv_tao: z.number().nullable(),
    // --- v440 emission pipeline (#8743) ---------------------------------
    // Optional, not required: a refresh whose node could not serve
    // state_queryStorageAt publishes the rest of the economics block rather
    // than nothing, so these keys are absent on a degraded run and null only
    // when the value itself is genuinely unknown.
    //
    // Alpha into the pool and alpha to participants. alpha_out_emission is
    // NOT a constant 1.0 -- it is a per-subnet halving curve that reads 1.0
    // today only because no subnet has crossed its first threshold.
    alpha_in_emission: z.number().nullable().optional(),
    alpha_out_emission: z.number().nullable().optional(),
    alpha_in_pool: z.number().nullable(),
    alpha_market_cap_tao: z.number().nullable(),
    alpha_out_pool: z.number().nullable(),
    alpha_price_change_1d: z.number().nullable().optional(),
    alpha_price_change_1h: z.number().nullable().optional(),
    alpha_price_change_1m: z.number().nullable().optional(),
    alpha_price_change_7d: z.number().nullable().optional(),
    alpha_price_tao: z.number().nullable(),
    block: z.int().min(0).nullable().optional(),
    emission_share: z.number().min(0).max(1).nullable(),
    // Stage 5. DEFAULTS TO TRUE on chain: absent storage is enabled and 0x00
    // is disabled, so 57 of 127 subnets are enabled with no entry at all.
    emission_enabled: z.boolean().nullable().optional(),
    // Stage 7: TAO the chain bought on this subnet's behalf.
    excess_tao: z.number().nullable().optional(),
    // Stage 0 eligibility. The block a subnet first emitted at, or null if it
    // never has.
    first_emission_block: z.int().min(0).nullable().optional(),
    max_stake_alpha: z.number().nullable(),
    max_uids: z.int().min(0),
    max_validators: z.int().min(0),
    miner_count: z.int().min(0),
    miner_readiness: z.int().min(0).max(100).nullable().optional(),
    // Stage 2. A FRACTION IN [0, 1], not an amount -- MinerBurned is U96F32
    // (divide by 2^32, never by 1e9). Verified across all 127 subnets: every
    // non-zero value lands in (0, 1] with a maximum of exactly 1.0, which a
    // misscaled amount would not.
    miner_burned_fraction: z.number().min(0).max(1).nullable().optional(),
    name: z.string(),
    netuid: z.int().min(0),
    open_slots: z.int().min(0).nullable().optional(),
    owner_coldkey: z.string().nullable(),
    owner_hotkey: z.string().nullable(),
    registration_allowed: z.boolean(),
    registration_cost_tao: z.number().nullable(),
    slug: z.string(),
    subnet_volume_tao: z.number().nullable(),
    // Stage 0 eligibility.
    subtoken_enabled: z.boolean().nullable().optional(),
    // Stage 1's input and stage 0's last gate, READ AT chain_state.block
    // (#8744) rather than off the bulk metagraph call the way alpha_price_tao
    // and registration_allowed are. Same chain items, different instant: the
    // bulk call runs at its own height, and every other term the
    // reconstruction combines these with is pinned. alpha_price_tao keeps its
    // own source and published meaning (ADR 0023 decision 1) -- these are a
    // second reading for the pipeline alone, which is why the names differ.
    //
    // Null is "not captured", never zero: a zero moving price is a real
    // stage-1 share of nothing, and conflating the two would hand a live
    // subnet a share of exactly 0.
    moving_price_pinned: z.number().nullable().optional(),
    registration_allowed_pinned: z.boolean().nullable().optional(),
    // Stage 8: TAO injected into this subnet's own pool. Its sum with
    // excess_tao across subnets equals the issuance-derived block emission.
    //
    // A POINT SAMPLE AT `chain_state.block`, AND THAT IS FINE (#8744). This
    // comment previously said the value was "noisy by construction" per block
    // and that a daily rollup was the reportable figure. Measured across 14
    // consecutive finney blocks (8,740,604-8,740,617), that is not what the
    // chain does: both channels move smoothly and near-monotonically -- a few
    // rao per block -- and the derived liquidity_fraction varies by 1.8e-6 to
    // 1.0e-5 over the window. That is ~20x tighter than the 2e-4 tolerance the
    // reconstruction itself carries, so a rollup would average away noise
    // smaller than the error already in the number. There is no rollup.
    tao_in_emission_tao: z.number().nullable().optional(),
    tao_in_pool_tao: z.number().nullable(),
    total_stake_alpha: z.number().nullable(),
    validator_count: z.int().min(0),
  })
  .strict();
export type SubnetEconomics = z.infer<typeof SubnetEconomicsSchema>;

// The block every v440 emission-pipeline read was pinned to (#8744), carried
// at the artifact's top level because one `state_queryStorageAt` produced the
// whole network's row set -- two subnets cannot disagree about it.
//
// ADR 0023 decision 5 makes provenance a contract, not a nice-to-have: the
// decomposition is OUR arithmetic over chain measurements, and a reader who
// cannot tell which block it was read at cannot check it. `block_hash` is here
// so that check is exact -- a height alone is ambiguous across a reorg.
//
// Absent (not null) on a degraded refresh whose node could not serve the
// pinned reads. Never defaulted to captured_at or to chain tip: a height that
// was not read from is worse than no height, because it looks like provenance.
export const ChainStateSchema = z
  .object({
    block: z.int().min(0),
    block_hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    // Block emission is derived from issuance (#8747), never read from the
    // stale `BlockEmission` storage item. Kept at the height so a historical
    // row stays interpretable against the emission in force when captured.
    total_issuance_tao: z.number().nonnegative(),
    // The gate's three parameters AT THIS BLOCK (#8744). Not captured at any
    // height before now, and a live read is the wrong number for 359 blocks
    // out of 360: the runtime recomputes theta whenever block % 360 == 0, and
    // gates with the STORED value in between.
    //
    // theta is null when the bar is unset, which disables the gate outright
    // (apply_emission_gate's own `if theta <= zero { return; }`).
    emission_gate_bar: z.number().nullable(),
    emission_bar_quantile: z.number().nullable(),
    // NULL MEANS THE RUNTIME DEFAULT h = 3, NOT ZERO. h = 0 would make the
    // Hill gate return exactly 0.5 for every subnet, so coercing absent to 0
    // silently replaces the gate with a constant. Left null here and resolved
    // by the consumer against DEFAULT_EMISSION_GATE_EXPONENT.
    emission_gate_exponent: z.int().nullable(),
  })
  .strict();
export type ChainState = z.infer<typeof ChainStateSchema>;

// Per-field provenance (#9078): every published value labelled `measured` --
// with the pallet-qualified storage item behind it -- or `reconstructed`, our
// own arithmetic over one or more measurements.
//
// ADR 0023 decision 5 introduced this on /api/v1/chain/emission-pipeline; it
// lives here because it is now the shape EVERY surface publishing a
// `field_sources` map uses, and a consumer should learn it once rather than
// once per endpoint. src/field-provenance.ts is its runtime counterpart.
//
// A record rather than a fixed object: the key set is each route's own field
// list, and pinning it here would mean re-declaring every route's shape twice.
// tests/field-provenance.test.ts is what holds the keys to the served fields.
export const FieldSourcesSchema = z
  .record(
    z.string(),
    z
      .object({
        kind: z.enum(["measured", "reconstructed"]),
        // #9106. Optional, and absent on every surface whose fields share one
        // read instant. Present on /api/v1/economics, whose bulk-call fields
        // and pinned storage reads happen at different heights -- including
        // two that are the SAME chain item at both. Absent on a reconstruction
        // spanning instants means "no single instant applies", not "unknown".
        read_at: z.enum(["capture", "chain_state.block"]).optional(),
        // Non-null exactly when kind is "measured". Null on a reconstruction
        // is a positive statement, not an omission: for `block_emission_tao`
        // it says we did NOT read the `BlockEmission` storage item, which is
        // stale (#8747) and would otherwise look like the obvious source.
        storage: z.string().nullable(),
      })
      .strict(),
  )
  .describe(
    "Per-field { kind, storage } provenance map: every value is labelled measured (with the pallet-qualified storage item it was read from) or reconstructed (our arithmetic over measurements, storage null). ADR 0023 decision 5.",
  );
export type FieldSources = z.infer<typeof FieldSourcesSchema>;

// One concentration lens over a single value distribution (src/concentration.ts's
// computeConcentration()) -- shared by SubnetPerformanceArtifact/
// ChainPerformanceArtifact's incentive/dividends lenses AND
// ChainConcentrationArtifact/AccountPortfolioArtifact/BlocksSummaryArtifact's
// own concentration fields (types-epic B batch 3, #8057; verified via
// repo-wide $ref grep -- unlike subnet-concentration.ts's ConcentrationLensSchema,
// which is deliberately NOT this component since the hand-edited
// SubnetConcentrationArtifact never $ref'd it either). Registered as a public
// OpenAPI component (schemas-src/openapi-registry.ts) since routes outside
// this batch still reference it by name.
export const ConcentrationMetricsSchema = z
  .object({
    holders: z.int().min(0).optional(),
    total: z.number().nullable().optional(),
    gini: z.number().nullable().optional(),
    hhi: z.number().nullable().optional(),
    hhi_normalized: z.number().nullable().optional(),
    nakamoto_coefficient: z.int().nullable().optional(),
    top_1pct_share: z.number().nullable().optional(),
    top_5pct_share: z.number().nullable().optional(),
    top_10pct_share: z.number().nullable().optional(),
    top_20pct_share: z.number().nullable().optional(),
    entropy: z.number().nullable().optional(),
    entropy_normalized: z.number().nullable().optional(),
  })
  .passthrough()
  .nullable()
  .describe(
    "One concentration lens over a single value distribution: holder count, total, and the Gini, HHI (raw and holder-count-normalized), Nakamoto coefficient, top-percentile cumulative shares, and Shannon entropy (raw and normalized) measures. Null when the distribution is empty (a cold store or an all-zero column).",
  );
export type ConcentrationMetrics = z.infer<typeof ConcentrationMetricsSchema>;

// Distribution summary of a 0-1 per-UID score across neurons (src/subnet-
// performance.ts's scoreDistribution()) -- shared by SubnetPerformanceArtifact/
// ChainPerformanceArtifact's trust/consensus/validator_trust lenses (types-epic
// B batch 3, #8057; verified via repo-wide $ref grep). Registered as a public
// OpenAPI component since ChainPerformanceArtifact (outside this batch) still
// references it by name.
export const ScoreDistributionSchema = z
  .object({
    count: z.int().min(0).optional(),
    mean: z.number().nullable().optional(),
    min: z.number().nullable().optional(),
    max: z.number().nullable().optional(),
    p10: z.number().nullable().optional(),
    p25: z.number().nullable().optional(),
    p50: z.number().nullable().optional(),
    p75: z.number().nullable().optional(),
    p90: z.number().nullable().optional(),
  })
  .passthrough()
  .nullable()
  .describe(
    "Distribution summary of a 0\u20131 per-UID score across neurons: count, mean, min, max, and the p10/p25/p50/p75/p90 nearest-rank percentiles. Null when no neuron carries a finite score (a cold store or an empty network).",
  );
export type ScoreDistribution = z.infer<typeof ScoreDistributionSchema>;
