// SubnetProfile and its sub-schemas (types-epic B batch 1, #8055) -- not a
// route response on their own, but the `profile` field SubnetOverviewArtifact
// (subnet-overview.ts) composes. Modeled directly from the hand-edited
// SubnetProfile/SubnetProfileNativeIdentity/SubnetProfilePrimaryLinks/
// SubnetProfileSurfaceSummary/SubnetProfileIdentityEvidence/
// SubnetProfileCompleteness/SubnetProfileProvenance/IntegrationReadiness
// components this file replaces. SubnetProfile and IntegrationReadiness are
// each referenced by several OTHER still-hand-edited components beyond
// subnet-overview (SubnetProfileIdentityEvidence also from
// 11-review-intake.schema.json's own component, IntegrationReadiness from
// two 04-surfaces.schema.json components) -- registering them under their
// existing names upgrades those untouched routes for free, the same
// pattern openapi-registry.ts's header documents for CurationMetadata/Gaps.
import { z } from "zod";
import {
  CurationLevelSchema,
  SubnetStatusSchema,
  SubnetTypeSchema,
} from "../shared.ts";
import { ReviewStateSchema, SurfaceKindSchema } from "./subnet-detail.ts";

export const SubnetProfileNativeIdentitySchema = z
  .object({
    source: z.string(),
    subnet_name: z.string().nullable(),
    description: z.string().nullable(),
    additional: z.string().nullable(),
    website_url: z.url().nullable(),
    github_url: z.url().nullable(),
    discord: z.string().max(200).nullable(),
    discord_url: z.url().nullable(),
    logo_url: z.url().nullable(),
    contact_present: z.boolean(),
  })
  .strict()
  .nullable();
export type SubnetProfileNativeIdentity = z.infer<
  typeof SubnetProfileNativeIdentitySchema
>;

export const SubnetProfilePrimaryLinksSchema = z
  .object({
    website_url: z.url().nullable(),
    docs_url: z.url().nullable(),
    source_repo: z.url().nullable(),
    dashboard_url: z.url().nullable(),
  })
  .strict();
export type SubnetProfilePrimaryLinks = z.infer<
  typeof SubnetProfilePrimaryLinksSchema
>;

export const SubnetProfileSurfaceSummarySchema = z
  .object({
    id: z.string(),
    key: z.string().optional(),
    kind: SurfaceKindSchema,
    name: z.string(),
    provider: z.string(),
    url: z.url(),
  })
  .strict()
  .nullable();
export type SubnetProfileSurfaceSummary = z.infer<
  typeof SubnetProfileSurfaceSummarySchema
>;

export const SubnetProfileIdentityEvidenceSchema = z
  .object({
    candidate_identity_count: z.int().min(0),
    curated_identity_count: z.int().min(0).max(3),
    curated_identity_kinds: z.array(SurfaceKindSchema),
    live_candidate_identity_kinds: z.array(SurfaceKindSchema),
    native_contact_present: z.boolean(),
    native_description_present: z.boolean(),
    native_identity_count: z.int().min(0).max(2),
    native_identity_kinds: z.array(SurfaceKindSchema),
    needs_promotion_kinds: z.array(SurfaceKindSchema),
    stale_candidate_identity_kinds: z.array(SurfaceKindSchema),
    unverified_candidate_identity_kinds: z.array(SurfaceKindSchema),
  })
  .strict();
export type SubnetProfileIdentityEvidence = z.infer<
  typeof SubnetProfileIdentityEvidenceSchema
>;

const PROFILE_CONFIDENCE = ["low", "medium", "high"] as const;
const PROFILE_LEVEL = [
  "directory-only",
  "identity-partial",
  "identity-complete",
  "operational",
  "adapter-backed",
] as const;
const IDENTITY_LEVEL = ["none", "directory", "partial", "complete"] as const;

export const SubnetProfileCompletenessSchema = z
  .object({
    score: z.int().min(0).max(100),
    profile_level: z.enum(PROFILE_LEVEL),
    identity_level: z.enum(IDENTITY_LEVEL),
    identity_surface_count: z.int().min(0).max(3),
    confidence: z.enum(PROFILE_CONFIDENCE),
    missing_identity: z.array(SurfaceKindSchema),
    missing_required: z.array(SurfaceKindSchema),
    missing_operational: z.array(SurfaceKindSchema),
    missing_critical_count: z.int().min(0),
    gap_reasons: z.array(z.string()),
  })
  .strict();
export type SubnetProfileCompleteness = z.infer<
  typeof SubnetProfileCompletenessSchema
>;

export const SubnetProfileProvenanceSchema = z
  .object({
    identity_source: z.string(),
    interface_source_count: z.int().min(0),
    review_state: ReviewStateSchema,
    curation_level: CurationLevelSchema,
    reviewed_at: z.string().nullable(),
    source_urls: z.array(z.url()),
  })
  .strict();
export type SubnetProfileProvenance = z.infer<
  typeof SubnetProfileProvenanceSchema
>;

const READINESS_TIER = [
  "buildable",
  "emerging",
  "identity-only",
  "dormant",
] as const;

export const IntegrationReadinessSchema = z
  .object({
    score: z.int().min(0).max(100),
    readiness_tier: z.enum(READINESS_TIER),
    readiness_version: z.int().min(1),
    readiness_verified: z.boolean().optional(),
    components: z
      .object({
        has_callable_api: z.boolean().optional(),
        documented: z.boolean().optional(),
        auth_clarity: z.boolean().optional(),
        callable_now: z.boolean().optional(),
        active_lifecycle: z.boolean().optional(),
        profile_complete: z.boolean().optional(),
        has_source_repo: z.boolean().optional(),
        has_public_docs: z.boolean().optional(),
        has_candidate_api: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();
export type IntegrationReadiness = z.infer<typeof IntegrationReadinessSchema>;

const NATIVE_NAME_QUALITY = ["chain", "placeholder", "empty"] as const;

export const SubnetProfileSchema = z
  .object({
    netuid: z.int().min(0),
    slug: z.string(),
    name: z.string(),
    native_name: z.string().nullable().optional(),
    native_name_quality: z.enum(NATIVE_NAME_QUALITY).optional(),
    native_identity: SubnetProfileNativeIdentitySchema,
    injection_scrubbed: z.boolean().optional(),
    subnet_type: SubnetTypeSchema,
    status: SubnetStatusSchema,
    symbol: z.string().nullable().optional(),
    project_name: z.string(),
    team: z.string().nullable(),
    categories: z.array(z.string()),
    derived_categories: z.array(z.string()),
    derived_description: z.string().nullable().optional(),
    lineage: z
      .object({
        graduated_from_testnet: z.boolean().optional(),
        also_on: z
          .array(
            z
              .object({
                network: z.string().optional(),
                netuid: z.int().min(0).optional(),
                name: z.string().nullable().optional(),
                matched_by: z.enum(["github_repo", "chain_name"]).optional(),
              })
              .passthrough(),
          )
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    primary_links: SubnetProfilePrimaryLinksSchema,
    primary_app_surface: SubnetProfileSurfaceSummarySchema,
    supported_interface_kinds: z.array(SurfaceKindSchema),
    operational_interface_kinds: z.array(SurfaceKindSchema),
    surface_count: z.int().min(0),
    endpoint_count: z.int().min(0),
    monitored_endpoint_count: z.int().min(0),
    candidate_count: z.int().min(0),
    identity_evidence: SubnetProfileIdentityEvidenceSchema,
    interface_count: z.int().min(0).optional(),
    operational_interface_count: z.int().min(0).optional(),
    completeness: SubnetProfileCompletenessSchema,
    provenance: SubnetProfileProvenanceSchema,
    curation_level: CurationLevelSchema,
    review_state: ReviewStateSchema,
    confidence: z.enum(PROFILE_CONFIDENCE),
    profile_level: z.enum(PROFILE_LEVEL),
    identity_level: z.enum(IDENTITY_LEVEL),
    identity_surface_count: z.int().min(0).max(3),
    completeness_score: z.int().min(0).max(100),
    missing_identity: z.array(SurfaceKindSchema),
    missing_required: z.array(SurfaceKindSchema),
    missing_operational: z.array(SurfaceKindSchema),
    missing_critical_count: z.int().min(0),
    gap_reasons: z.array(z.string()),
    suggested_submission_kinds: z.array(SurfaceKindSchema),
    integration_readiness: z.int().min(0).max(100).optional(),
    readiness: IntegrationReadinessSchema.optional(),
  })
  .strict();
export type SubnetProfile = z.infer<typeof SubnetProfileSchema>;
