// GET /api/v1/review/gaps, GET /api/v1/subnets/{netuid}/gaps,
// GET /api/v1/review/profile-completeness (types-epic B batch 8, #8062).
// review/gaps and review/profile-completeness mirror their MCP siblings
// (list_review_gaps, list_profile_completeness -- types-epic E batch 11,
// #8074's enrichment-evidence-and-targets.ts and batch 9, #8073's
// registry-catalogs-2.ts -- "mirrors GET /api/v1/review/..." in their own
// hand-written descriptions confirms query-param parity). subnets/{netuid}/
// gaps mirrors get_subnet_gaps (netuid is a path param; no query params
// beyond it). Modeled from the hand-edited ReviewGapPrioritiesArtifact
// (+ReviewGapPriority), SubnetGapsArtifact, and
// ReviewProfileCompletenessArtifact(+Entry) components they replace.
import { z } from "zod";
import {
  ArtifactBaseSchema,
  CountMapSchema,
  successEnvelopeSchema,
} from "../envelope.ts";
import { CurationLevelSchema } from "../shared.ts";
import { ReviewStateSchema, SurfaceKindSchema } from "./subnet-detail.ts";
import { SubnetProfileIdentityEvidenceSchema } from "./subnet-profile.ts";
import { ReviewEnrichmentQueueEntrySchema } from "./review-enrichment.ts";

const CURATION_LEVELS = [
  "native",
  "candidate-discovered",
  "community-seeded",
  "machine-verified",
  "maintainer-reviewed",
  "adapter-backed",
] as const;
const SURFACE_KINDS = [
  "archive",
  "dashboard",
  "data-artifact",
  "docs",
  "example",
  "openapi",
  "repo-registry",
  "sdk",
  "source-repo",
  "sse",
  "subnet-api",
  "subtensor-rpc",
  "subtensor-wss",
  "website",
] as const;
const PRIORITY_SORT_FIELDS = [
  "candidate_count",
  "curation_level",
  "missing_kinds",
  "name",
  "netuid",
  "priority_score",
  "surface_count",
  "verified_candidate_count",
] as const;

export const ReviewGapsQuerySchema = z
  .object({
    netuid: z.int().min(0).optional(),
    curation_level: z.enum(CURATION_LEVELS).optional(),
    missing_kinds: z.enum(SURFACE_KINDS).optional(),
    review_state: z.string().optional(),
    sort: z.enum(PRIORITY_SORT_FIELDS).optional(),
    order: z.enum(["asc", "desc"]).optional(),
    fields: z.string().optional(),
    limit: z.int().min(1).max(100).optional(),
    cursor: z.int().min(0).optional(),
  })
  .strict();
export type ReviewGapsQuery = z.infer<typeof ReviewGapsQuerySchema>;

export const ReviewGapPrioritySchema = z
  .object({
    candidate_count: z.int().min(0),
    curation_level: CurationLevelSchema,
    missing_kinds: z.array(SurfaceKindSchema),
    name: z.string(),
    netuid: z.int().min(0),
    priority_score: z.int().min(0),
    review_state: ReviewStateSchema,
    slug: z.string(),
    suggested_next_action: z.string(),
    surface_count: z.int().min(0),
    verified_candidate_count: z.int().min(0),
  })
  .strict();

export const ReviewGapPrioritiesArtifactSchema = ArtifactBaseSchema.extend({
  priorities: z.array(ReviewGapPrioritySchema),
}).passthrough();
export type ReviewGapPrioritiesArtifact = z.infer<
  typeof ReviewGapPrioritiesArtifactSchema
>;
export const ReviewGapPrioritiesResponseSchema = successEnvelopeSchema(
  ReviewGapPrioritiesArtifactSchema,
);

export const SubnetGapsArtifactSchema = ArtifactBaseSchema.extend({
  netuid: z.int().min(0),
  slug: z.string().optional(),
  name: z.string().optional(),
  priorities: z.array(ReviewGapPrioritySchema),
  enrichment_queue: z.array(ReviewEnrichmentQueueEntrySchema),
}).passthrough();
export type SubnetGapsArtifact = z.infer<typeof SubnetGapsArtifactSchema>;
export const SubnetGapsResponseSchema = successEnvelopeSchema(
  SubnetGapsArtifactSchema,
);

const PROFILE_LEVELS = [
  "directory-only",
  "identity-partial",
  "identity-complete",
  "operational",
  "adapter-backed",
] as const;
const CONFIDENCE_LEVELS = ["low", "medium", "high"] as const;
const IDENTITY_LEVELS = ["none", "directory", "partial", "complete"] as const;
const NATIVE_NAME_QUALITIES = ["chain", "placeholder", "empty"] as const;
const PROFILE_SORT_FIELDS = [
  "candidate_count",
  "completeness_score",
  "identity_level",
  "identity_promotion_kind_count",
  "identity_surface_count",
  "live_identity_candidate_kind_count",
  "missing_critical_count",
  "name",
  "native_identity_signal_count",
  "native_name_quality",
  "netuid",
  "priority_score",
  "profile_level",
  "stale_identity_candidate_kind_count",
] as const;

export const ReviewProfileCompletenessQuerySchema = z
  .object({
    netuid: z.int().min(0).optional(),
    profile_level: z.enum(PROFILE_LEVELS).optional(),
    confidence: z.enum(CONFIDENCE_LEVELS).optional(),
    identity_level: z.enum(IDENTITY_LEVELS).optional(),
    identity_promotion_kinds: z.enum(SURFACE_KINDS).optional(),
    native_name_quality: z.enum(NATIVE_NAME_QUALITIES).optional(),
    sort: z.enum(PROFILE_SORT_FIELDS).optional(),
    order: z.enum(["asc", "desc"]).optional(),
    fields: z.string().optional(),
    limit: z.int().min(1).max(100).optional(),
    cursor: z.int().min(0).optional(),
  })
  .strict();
export type ReviewProfileCompletenessQuery = z.infer<
  typeof ReviewProfileCompletenessQuerySchema
>;

export const ReviewProfileCompletenessEntrySchema = z
  .object({
    candidate_count: z.int().min(0),
    completeness_score: z.int().min(0).max(100),
    confidence: z.enum(CONFIDENCE_LEVELS),
    curation_level: CurationLevelSchema,
    gap_reasons: z.array(z.string()),
    identity_level: z.enum(IDENTITY_LEVELS),
    identity_evidence: SubnetProfileIdentityEvidenceSchema,
    identity_promotion_kind_count: z.int().min(0),
    identity_promotion_kinds: z.array(SurfaceKindSchema),
    identity_surface_count: z.int().min(0).max(3),
    live_identity_candidate_kind_count: z.int().min(0),
    missing_critical_count: z.int().min(0),
    missing_identity: z.array(SurfaceKindSchema),
    missing_operational: z.array(SurfaceKindSchema),
    missing_required: z.array(SurfaceKindSchema),
    name: z.string(),
    native_name_quality: z.enum(NATIVE_NAME_QUALITIES),
    native_identity_signal_count: z.int().min(0),
    netuid: z.int().min(0),
    operational_interface_count: z.int().min(0),
    priority_score: z.int().min(0),
    profile_level: z.enum(PROFILE_LEVELS),
    review_state: ReviewStateSchema,
    slug: z.string(),
    source_count: z.int().min(0),
    stale_identity_candidate_kind_count: z.int().min(0),
    supported_interface_kinds: z.array(SurfaceKindSchema),
    suggested_next_action: z.string(),
  })
  .strict();

export const ReviewProfileCompletenessArtifactSchema =
  ArtifactBaseSchema.extend({
    profiles: z.array(ReviewProfileCompletenessEntrySchema),
    summary: z
      .object({
        profile_count: z.int().min(0),
        needs_identity_count: z.int().min(0),
        needs_operational_count: z.int().min(0),
        average_completeness_score: z.int().min(0).max(100),
        native_identity_count: z.int().min(0),
        identity_promotion_candidate_count: z.int().min(0),
        native_identity_unpromoted_count: z.int().min(0),
        by_identity_level: CountMapSchema,
        by_profile_level: CountMapSchema,
        by_confidence: CountMapSchema,
        critical_gap_counts: CountMapSchema,
      })
      .strict(),
  }).passthrough();
export type ReviewProfileCompletenessArtifact = z.infer<
  typeof ReviewProfileCompletenessArtifactSchema
>;
export const ReviewProfileCompletenessResponseSchema = successEnvelopeSchema(
  ReviewProfileCompletenessArtifactSchema,
);
