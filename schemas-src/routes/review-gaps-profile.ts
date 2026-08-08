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
import {
  CONFIDENCE_LEVEL_VALUES,
  IDENTITY_LEVEL_VALUES,
  NATIVE_NAME_QUALITY_VALUES,
  PROFILE_LEVEL_VALUES,
} from "../shared.ts";
export const PRIORITY_SORT_FIELDS = [
  "candidate_count",
  "curation_level",
  "missing_kinds",
  "name",
  "netuid",
  "priority_score",
  "surface_count",
  "verified_candidate_count",
] as const;

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

export const PROFILE_SORT_FIELDS = [
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

export const ReviewProfileCompletenessEntrySchema = z
  .object({
    candidate_count: z.int().min(0),
    completeness_score: z.int().min(0).max(100),
    confidence: z.enum(CONFIDENCE_LEVEL_VALUES),
    curation_level: CurationLevelSchema,
    gap_reasons: z.array(z.string()),
    identity_level: z.enum(IDENTITY_LEVEL_VALUES),
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
    native_name_quality: z.enum(NATIVE_NAME_QUALITY_VALUES),
    native_identity_signal_count: z.int().min(0),
    netuid: z.int().min(0),
    operational_interface_count: z.int().min(0),
    priority_score: z.int().min(0),
    profile_level: z.enum(PROFILE_LEVEL_VALUES),
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
