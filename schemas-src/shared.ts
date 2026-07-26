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
    max_stake_tao: z.number().nullable(),
    max_uids: z.int().min(0),
    max_validators: z.int().min(0),
    miner_count: z.int().min(0),
    miner_readiness: z.int().min(0).max(100).nullable().optional(),
    name: z.string(),
    netuid: z.int().min(0),
    open_slots: z.int().min(0).nullable().optional(),
    owner_coldkey: z.string().nullable(),
    owner_hotkey: z.string().nullable(),
    registration_allowed: z.boolean(),
    registration_cost_tao: z.number().nullable(),
    slug: z.string(),
    subnet_volume_tao: z.number().nullable(),
    tao_in_pool_tao: z.number().nullable(),
    total_stake_tao: z.number().nullable(),
    validator_count: z.int().min(0),
  })
  .strict();
export type SubnetEconomics = z.infer<typeof SubnetEconomicsSchema>;

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
  .nullable();
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
  .nullable();
export type ScoreDistribution = z.infer<typeof ScoreDistributionSchema>;
