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
    since: z.string(),
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
