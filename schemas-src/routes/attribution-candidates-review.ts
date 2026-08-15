// GET /api/v1/review/attribution-candidates (#11227): the attribution sweep's
// review queue. Modeled from src/attribution-candidates-review.ts's
// buildAttributionCandidatesReview().
//
// EVERY ROW IS A LEAD, NEVER AN ATTRIBUTION, and the schema says so in the
// place a caller reads: an ss58 that appeared in text on a page a subnet
// published is not an address that belongs to that subnet. `source_url` is
// required on every candidate for exactly that reason — the reviewer's job is
// to open it.
import { z } from "zod";
import { UnavailableDegradedSchema } from "./event-stream-honesty.ts";

export const AttributionCandidateSchema = z
  .object({
    netuid: z.int().min(0).max(65535),
    ss58: z
      .string()
      .describe(
        "A checksum-valid Finney address found in the text of source_url. NOT an attribution: the common false positive is a hotkey belonging to a validator, appearing inside an API response that validator publishes -- somebody else's key, on their own page. Clearing the evidence bar is a human judgement this row exists to prompt, not to replace.",
      ),
    source_url: z
      .string()
      .describe(
        "The page the address was found on. Required on every candidate, because the review is opening it -- a row a reviewer cannot trace back to a document is not reviewable.",
      ),
    first_seen: z.iso.datetime().nullable(),
    last_seen: z.iso.datetime().nullable(),
    source_address_count: z
      .int()
      .min(0)
      .nullable()
      .describe(
        "How many distinct addresses that page yielded. The reviewer's first filter: an address found on a page carrying eleven others is a weaker lead than one found alone. Anything above listing_address_cap is suppressed entirely rather than shown with a warning.",
      ),
  })
  .strict();

export const AttributionCandidatesReviewArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z
      .int()
      .min(0)
      .max(65535)
      .nullable()
      .describe("The subnet filter applied, or null for every subnet."),
    limit: z.int().min(1).nullable(),
    offset: z.int().min(0).nullable(),
    candidate_count: z
      .int()
      .min(0)
      .nullable()
      .describe(
        "Rows on THIS page. Never the population -- see reviewable_count, which is measured over the whole table.",
      ),
    reviewable_count: z
      .int()
      .min(0)
      .nullable()
      .describe(
        "Candidates passing the listing rule across the whole table, before ?limit=. Published so a bounded page can never be mistaken for the population; NULL when the count could not be read, never defaulted to the page length.",
      ),
    suppressed_count: z
      .int()
      .min(0)
      .nullable()
      .describe(
        "Candidates hidden because the page they came from is a LISTING -- a metagraph dump or holder list, every address on which belongs to somebody else. Published rather than silently applied: a filter a caller cannot see is one they cannot check.",
      ),
    suppressed_source_count: z
      .int()
      .min(0)
      .nullable()
      .describe("How many distinct source pages that suppression covered."),
    listing_address_cap: z
      .int()
      .min(1)
      .describe(
        "The rule: a source yielding MORE than this many distinct addresses is a listing and contributes no candidates. Published so a caller can reproduce the split rather than trust it. A judgement calibrated on an empty band in the observed distribution, not a law.",
      ),
    candidates: z.array(AttributionCandidateSchema),
    degraded: UnavailableDegradedSchema.optional().describe(
      "Present ONLY on a decline. An empty queue is a measurement -- every candidate adjudicated, or every source a listing, or a subnet nobody has swept.",
    ),
  })
  .strict();
export type AttributionCandidatesReviewArtifact = z.infer<
  typeof AttributionCandidatesReviewArtifactSchema
>;
/** One row, named so src/attribution-candidates-review.ts types its accumulator
 * against the published contract rather than a bare record — which is what
 * stops a field being added to one and not the other. */
export type AttributionCandidate = z.infer<typeof AttributionCandidateSchema>;
