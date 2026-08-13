// GET /api/v1/review/enrichment-queue, GET /api/v1/review/enrichment-evidence,
// GET /api/v1/review/enrichment-targets, GET /api/v1/review/adapter-candidates
// (types-epic B batch 8, #8062). Each mirrors its MCP sibling
// (list_enrichment_queue/list_enrichment_evidence/
// list_review_enrichment_targets/list_adapter_candidates, types-epic E
// batch 11, #8074's enrichment-queue-and-candidates.ts and
// enrichment-evidence-and-targets.ts -- "mirrors GET /api/v1/review/..." in
// their own hand-written descriptions confirms behavioral/query-param
// parity, unlike the MCP tools' own deliberately loose output items).
// Modeled from the hand-edited ReviewEnrichmentQueueArtifact(+Entry),
// ReviewEnrichmentEvidenceArtifact(+Entry), ReviewEnrichmentTargetsArtifact
// (+Target/TargetGroup), and ReviewAdapterCandidatesArtifact(+Candidate)
// components they replace.
import { z } from "zod";
import { API_QUERY_COLLECTIONS } from "../../src/contracts.ts";
import { QUERY_ENUMS } from "../query-enums.ts";
import { ArtifactBaseSchema, CountMapSchema } from "../envelope.ts";
import { CurationLevelSchema } from "../shared.ts";
import { ReviewStateSchema, SurfaceKindSchema } from "./subnet-detail.ts";
import { IDENTITY_LEVEL_VALUES, PROFILE_LEVEL_VALUES } from "../shared.ts";

/** The vocabulary, exported as a tuple so every other schema that needs
 * these values imports them instead of restating them (#9799). */
export const REVIEW_ENRICHMENT_LANE_VALUES = [
  "direct-submission",
  "maintainer-review",
  "adapter-candidate",
  "monitoring-followup",
  "baseline-monitoring",
] as const;
export const ReviewEnrichmentLaneSchema = z.enum(REVIEW_ENRICHMENT_LANE_VALUES);
/** The vocabulary, exported as a tuple so every other schema that needs
 * these values imports them instead of restating them (#9799). */
export const REVIEW_EVIDENCE_ACTION_VALUES = [
  "submit-new-evidence",
  "verify-existing-evidence",
  "replace-stale-evidence",
  "review-existing-evidence",
  "maintainer-review-existing-evidence",
  "monitor",
] as const;
export const ReviewEvidenceActionSchema = z.enum(REVIEW_EVIDENCE_ACTION_VALUES);
/** The vocabulary, exported as a tuple so every other schema that needs
 * these values imports them instead of restating them (#9799). */
export const REVIEW_ENRICHMENT_TARGET_TYPE_VALUES = [
  "surface-candidate",
  "adapter-review",
  "maintainer-review",
  "monitoring-followup",
] as const;
export const ReviewEnrichmentTargetTypeSchema = z.enum(
  REVIEW_ENRICHMENT_TARGET_TYPE_VALUES,
);
/** The vocabulary, exported as a tuple so every other schema that needs
 * these values imports them instead of restating them (#9799). */
export const REVIEW_ENRICHMENT_SUBMISSION_ROUTE_VALUES = [
  "direct-candidate-pr",
  "adapter-request",
  "maintainer-review",
  "status-report",
] as const;
export const ReviewEnrichmentSubmissionRouteSchema = z.enum(
  REVIEW_ENRICHMENT_SUBMISSION_ROUTE_VALUES,
);
/** The vocabulary, exported as a tuple so every other schema that needs
 * these values imports them instead of restating them (#9799). */
export const REVIEW_ENRICHMENT_TARGET_ACTION_VALUES = [
  "submit-new-candidate",
  "replace-stale-candidate",
  "verify-existing-candidate",
  "review-existing-candidate",
  "adapter-review",
  "maintainer-review",
  "monitoring-followup",
] as const;
export const ReviewEnrichmentTargetActionSchema = z.enum(
  REVIEW_ENRICHMENT_TARGET_ACTION_VALUES,
);

export const ReviewCandidateEvidenceSchema = z
  .object({
    candidate_count: z.int().min(0),
    classifications: CountMapSchema,
    live_or_redirected_count: z.int().min(0),
    reviewable_count: z.int().min(0),
    sample_candidate_ids: z.array(z.string()),
    stale_or_failed_count: z.int().min(0),
    unverified_count: z.int().min(0),
  })
  .strict();

export const ReviewCandidateEvidenceSummarySchema = z
  .object({
    candidate_count: z.int().min(0),
    kinds_with_candidates: z.array(SurfaceKindSchema),
    live_kinds: z.array(SurfaceKindSchema),
    live_or_redirected_count: z.int().min(0),
    reviewable_count: z.int().min(0),
    stale_kinds: z.array(SurfaceKindSchema),
    stale_or_failed_count: z.int().min(0),
    unverified_count: z.int().min(0),
    unverified_kinds: z.array(SurfaceKindSchema),
  })
  .strict();

export const ReviewEnrichmentTargetQueueContextSchema = z
  .object({
    adapter_score: z.int().min(0),
    candidate_count: z.int().min(0),
    completeness_score: z.int().min(0).max(100),
    curation_level: CurationLevelSchema,
    direct_submission_kind_count: z.int().min(0),
    endpoint_count: z.int().min(0),
    identity_surface_count: z.int().min(0).max(3),
    operational_interface_count: z.int().min(0),
    profile_level: z.enum(PROFILE_LEVEL_VALUES),
    review_state: ReviewStateSchema,
    source_url_count: z.int().min(0),
    stale_candidate_count: z.int().min(0),
    surface_count: z.int().min(0),
    verified_candidate_count: z.int().min(0),
  })
  .strict();

export const QUEUE_SORT_FIELDS =
  API_QUERY_COLLECTIONS["enrichment-queue"].sort_fields;

export const ReviewEnrichmentQueueEntrySchema = z
  .object({
    adapter_score: z.int().min(0),
    candidate_count: z.int().min(0),
    candidate_evidence_summary: ReviewCandidateEvidenceSummarySchema,
    completeness_score: z.int().min(0).max(100),
    contribution_hint: z.string(),
    curation_level: CurationLevelSchema,
    direct_submission_kinds: z.array(SurfaceKindSchema),
    endpoint_count: z.int().min(0),
    evidence_action: ReviewEvidenceActionSchema,
    identity_level: z.enum(IDENTITY_LEVEL_VALUES),
    identity_surface_count: z.int().min(0).max(3),
    lane: ReviewEnrichmentLaneSchema,
    manual_review_required: z.boolean(),
    missing_kinds: z.array(SurfaceKindSchema),
    missing_identity: z.array(SurfaceKindSchema),
    name: z.string(),
    netuid: z.int().min(0),
    operational_interface_count: z.int().min(0),
    priority_score: z.int().min(0),
    profile_level: z.enum(PROFILE_LEVEL_VALUES),
    reason_codes: z.array(z.string()),
    recommended_action: z.string(),
    review_state: ReviewStateSchema,
    sample_candidate_ids: z.array(z.string()),
    sample_live_candidate_ids: z.array(z.string()),
    sample_stale_candidate_ids: z.array(z.string()),
    sample_target_candidate_ids: z.array(z.string()),
    slug: z.string(),
    source_urls: z.array(z.url()),
    stale_candidate_count: z.int().min(0),
    surface_count: z.int().min(0),
    verified_candidate_count: z.int().min(0),
  })
  .strict();

export const ReviewEnrichmentQueueArtifactSchema = ArtifactBaseSchema.extend({
  notes: z.string(),
  queue: z.array(ReviewEnrichmentQueueEntrySchema),
  summary: z
    .object({
      adapter_candidate_count: z.int().min(0),
      baseline_monitoring_count: z.int().min(0),
      direct_submission_count: z.int().min(0),
      evidence_action_counts: CountMapSchema,
      identity_level_counts: CountMapSchema,
      lane_counts: CountMapSchema,
      maintainer_review_count: z.int().min(0),
      manual_review_required_count: z.int().min(0),
      monitoring_followup_count: z.int().min(0),
      queue_count: z.int().min(0),
      subnet_count: z.int().min(0),
      top_direct_submission_kinds: CountMapSchema,
    })
    .strict(),
}).strict();
export type ReviewEnrichmentQueueArtifact = z.infer<
  typeof ReviewEnrichmentQueueArtifactSchema
>;

export const EVIDENCE_SORT_FIELDS =
  API_QUERY_COLLECTIONS["enrichment-evidence"].sort_fields;

export const ReviewEnrichmentEvidenceEntrySchema = z
  .object({
    candidate_evidence_by_kind: z.record(
      z.string(),
      ReviewCandidateEvidenceSchema,
    ),
    candidate_evidence_summary: ReviewCandidateEvidenceSummarySchema,
    direct_submission_kinds: z.array(SurfaceKindSchema),
    evidence_action: ReviewEvidenceActionSchema,
    lane: ReviewEnrichmentLaneSchema,
    missing_kinds: z.array(SurfaceKindSchema),
    name: z.string(),
    netuid: z.int().min(0),
    priority_score: z.int().min(0),
    slug: z.string(),
  })
  .strict();

export const ReviewEnrichmentEvidenceArtifactSchema = ArtifactBaseSchema.extend(
  {
    entries: z.array(ReviewEnrichmentEvidenceEntrySchema),
    notes: z.string(),
    summary: z
      .object({
        entry_count: z.int().min(0),
        evidence_action_counts: CountMapSchema,
        stale_candidate_count: z.int().min(0),
        subnet_count: z.int().min(0),
        unverified_candidate_count: z.int().min(0),
      })
      .strict(),
  },
).strict();
export type ReviewEnrichmentEvidenceArtifact = z.infer<
  typeof ReviewEnrichmentEvidenceArtifactSchema
>;

export const TARGET_SORT_FIELDS =
  API_QUERY_COLLECTIONS["enrichment-targets"].sort_fields;

export const ReviewEnrichmentTargetSchema = z
  .object({
    auto_review_candidate: z.boolean(),
    candidate_command: z.string().nullable(),
    candidate_evidence: ReviewCandidateEvidenceSchema.nullable(),
    contribution_prompt: z.string(),
    evidence_action: ReviewEvidenceActionSchema,
    identity_level: z.enum(IDENTITY_LEVEL_VALUES),
    kind: SurfaceKindSchema.nullable(),
    lane: ReviewEnrichmentLaneSchema,
    manual_review_required: z.boolean(),
    missing_kinds: z.array(SurfaceKindSchema),
    name: z.string(),
    netuid: z.int().min(0),
    priority_score: z.int().min(0),
    profile_level: z.enum(PROFILE_LEVEL_VALUES),
    queue_context: ReviewEnrichmentTargetQueueContextSchema,
    reason_codes: z.array(z.string()),
    recommended_action: z.string(),
    sample_live_candidate_ids: z.array(z.string()),
    sample_stale_candidate_ids: z.array(z.string()),
    sample_target_candidate_ids: z.array(z.string()),
    slug: z.string(),
    source_requirements: z.array(z.string()),
    source_urls: z.array(z.url()),
    submission_route: ReviewEnrichmentSubmissionRouteSchema,
    target_action: ReviewEnrichmentTargetActionSchema,
    target_id: z.string(),
    target_type: ReviewEnrichmentTargetTypeSchema,
  })
  .strict();

export const ReviewEnrichmentTargetGroupSchema = z
  .object({
    auto_review_candidate_count: z.int().min(0),
    kind: SurfaceKindSchema.nullable(),
    manual_review_required_count: z.int().min(0),
    target_count: z.int().min(0),
    target_ids: z.array(z.string()),
    target_type: ReviewEnrichmentTargetTypeSchema,
    top_netuids: z.array(z.int().min(0)),
  })
  .strict();

export const ReviewEnrichmentTargetsArtifactSchema = ArtifactBaseSchema.extend({
  groups: z.array(ReviewEnrichmentTargetGroupSchema),
  notes: z.string(),
  summary: z
    .object({
      auto_review_candidate_count: z.int().min(0),
      by_evidence_action: CountMapSchema,
      by_kind: CountMapSchema,
      by_lane: CountMapSchema,
      by_target_type: CountMapSchema,
      manual_review_required_count: z.int().min(0),
      new_evidence_count: z.int().min(0),
      stale_replacement_count: z.int().min(0),
      subnet_count: z.int().min(0),
      target_count: z.int().min(0),
    })
    .strict(),
  targets: z.array(ReviewEnrichmentTargetSchema),
}).strict();
export type ReviewEnrichmentTargetsArtifact = z.infer<
  typeof ReviewEnrichmentTargetsArtifactSchema
>;

export const RECOMMENDED_ADAPTER_KINDS = QUERY_ENUMS.recommendedAdapterKind;
export const ADAPTER_CANDIDATES_SORT_FIELDS =
  API_QUERY_COLLECTIONS["adapter-candidates"].sort_fields;

export const ReviewAdapterCandidateSchema = z
  .object({
    candidate_api_count: z.int().min(0),
    candidate_api_ids: z.array(z.string()),
    candidate_api_kinds: z.array(SurfaceKindSchema),
    curation_level: CurationLevelSchema,
    name: z.string(),
    netuid: z.int().min(0),
    operational_kinds: z.array(SurfaceKindSchema),
    operational_surface_count: z.int().min(0),
    operational_surface_ids: z.array(z.string()),
    priority_score: z.int().min(0),
    reason_codes: z.array(z.string()),
    recommended_adapter_kind: z.enum(RECOMMENDED_ADAPTER_KINDS),
    suggested_next_action: z.string(),
    slug: z.string(),
  })
  .strict();

export const ReviewAdapterCandidatesArtifactSchema = ArtifactBaseSchema.extend({
  candidates: z.array(ReviewAdapterCandidateSchema),
  summary: z
    .object({
      adapter_backed_count: z.int().min(0),
      candidate_api_kind_counts: CountMapSchema,
      candidate_count: z.int().min(0),
      by_curation_level: CountMapSchema,
      by_recommended_adapter_kind: CountMapSchema,
      data_artifact_backed_count: z.int().min(0),
      openapi_backed_count: z.int().min(0),
      operational_kind_counts: CountMapSchema,
      sse_backed_count: z.int().min(0),
    })
    .strict(),
}).strict();
export type ReviewAdapterCandidatesArtifact = z.infer<
  typeof ReviewAdapterCandidatesArtifactSchema
>;
