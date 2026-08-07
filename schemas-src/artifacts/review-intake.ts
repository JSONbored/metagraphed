// The maintainer-review artifacts (#9830):
//   /metagraph/review/curation.json            -> ReviewCurationArtifact
//   /metagraph/review/maintainer-decisions.json -> ReviewDecisionsArtifact
//   /metagraph/review-queue.json                -> ReviewQueueArtifact
// plus the ReviewDecision leaf both of the first two carry. No REST route
// serves any of them (see the sibling surface-aliases.ts header for why these
// live under artifacts/).
//
// Modeled from scripts/build-artifacts.ts's buildCurationReview() and the
// review/maintainer-decisions.json write site, which are the only producers.
// The two per-subnet row shapes (`gap_priorities`, `adapter_candidates`) are
// reused from schemas-src/routes/review-gaps-profile.ts and
// review-enrichment.ts rather than restated here -- the same rows the
// /api/v1/review/* routes serve, so the two cannot drift apart.
import { z } from "zod";
import { ArtifactBaseSchema, CountMapSchema } from "../envelope.ts";
import { CandidatesArtifactSchema } from "../routes/candidates-evidence.ts";
import { ReviewAdapterCandidateSchema } from "../routes/review-enrichment.ts";
import { ReviewGapPrioritySchema } from "../routes/review-gaps-profile.ts";

export const ReviewDecisionSchema = z
  .object({
    confidence: z.enum(["low", "medium", "high"]),
    decision: z.enum([
      "maintainer-reviewed",
      "needs-review",
      "rejected",
      "stale",
    ]),
    netuid: z.int().min(0),
    notes: z.string(),
    reviewed_at: z.string(),
    slug: z.string(),
    source_urls: z.array(z.url()),
  })
  .strict();
export type ReviewDecision = z.infer<typeof ReviewDecisionSchema>;

const ReviewCurationSummarySchema = z
  .object({
    adapter_candidate_count: z.int().min(0),
    gap_kind_counts: CountMapSchema,
    maintainer_decision_count: z.int().min(0),
    needs_maintainer_review_count: z
      .int()
      .min(0)
      .describe(
        "Subnets whose `curation.review_state` is anything other than `maintainer-reviewed` -- the backlog, not a failure count.",
      ),
    subnet_count: z.int().min(0),
  })
  .strict();

export const ReviewCurationArtifactSchema = ArtifactBaseSchema.extend({
  adapter_candidates: z.array(ReviewAdapterCandidateSchema),
  gap_priorities: z.array(ReviewGapPrioritySchema),
  review_decisions: z.array(ReviewDecisionSchema),
  summary: ReviewCurationSummarySchema,
});
export type ReviewCurationArtifact = z.infer<
  typeof ReviewCurationArtifactSchema
>;

export const ReviewDecisionsArtifactSchema = ArtifactBaseSchema.extend({
  decisions: z.array(ReviewDecisionSchema),
});
export type ReviewDecisionsArtifact = z.infer<
  typeof ReviewDecisionsArtifactSchema
>;

// The review queue publishes the candidates artifact unchanged. z.lazy()
// rather than a second reference to CandidatesArtifactSchema: registering one
// Zod node twice would overwrite the first id, and this emits exactly the
// `{"$ref": "#/components/schemas/CandidatesArtifact"}` alias the
// hand-written component published.
export const ReviewQueueArtifactSchema = z.lazy(() => CandidatesArtifactSchema);
