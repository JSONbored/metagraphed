// /metagraph/verification/latest.json -> VerificationArtifact, and
// /metagraph/verification/subnets/{netuid}.json ->
// SubnetVerificationArtifact (#9830). The candidate-surface verification
// snapshot: what each candidate URL actually answered when it was probed. No
// REST route serves either (see the sibling surface-aliases.ts header for why
// these live under artifacts/).
//
// Modeled from scripts/verify-candidates.ts (which produces the source
// artifact), scripts/build-artifacts.ts's buildFullVerificationArtifact()
// (which filters `results` to complete rows and republishes the rest
// unchanged), and the per-subnet write site.
//
// THE ALIAS WAS A LIE. The hand-written contract published
// SubnetVerificationArtifact as `{"$ref": ".../VerificationArtifact"}` --
// the two are the same shape. They are not, and migrating to Zod is what
// surfaced it: validate:schemas rejected all 60 committed per-subnet
// artifacts the moment the summary was typed instead of left as an open
// object. The per-subnet artifact carries `netuid`/`slug`/`name` (none of
// them declared anywhere before) and a summary WITHOUT `promotable_count`
// -- promotability is a decision about the whole run, so the per-subnet
// slice has no such number to report. Each is its own component now, and the
// shared part is shared by composition rather than by claiming they are
// identical.
//
// `summary` WAS AN UNTYPED BLOB -- `{"type":"object"}` and nothing more, one
// of the sites #9800 counts. It is not arbitrary: both producers build it
// from a fixed object literal of label -> count maps.
import { z } from "zod";
import { ArtifactBaseSchema, CountMapSchema } from "../envelope.ts";
import { VerificationResultSchema } from "../routes/subnet-detail.ts";

// The rollups both artifacts share.
const VerificationSummaryBaseSchema = z
  .object({
    by_classification: CountMapSchema,
    by_kind: CountMapSchema,
    by_provider: CountMapSchema,
  })
  .strict();

const VerificationSummarySchema = VerificationSummaryBaseSchema.extend({
  promotable_count: z
    .int()
    .min(0)
    .describe(
      "Results that cleared the promotion bar -- a candidate this run would move into the registry. Whole-run only: the per-subnet artifact has no equivalent.",
    ),
});

export const VerificationArtifactSchema = ArtifactBaseSchema.extend({
  candidate_count: z
    .int()
    .min(0)
    .describe(
      "Length of `results` AFTER buildFullVerificationArtifact() drops rows missing candidate_id/classification/status/url/verified_at -- not the number of candidates the run started with.",
    ),
  observed_at: z.string().meta({ format: "date-time" }).nullable().optional(),
  verification_started_at: z.string().nullable().optional(),
  verification_finished_at: z.string().nullable().optional(),
  summary: VerificationSummarySchema.optional(),
  results: z.array(VerificationResultSchema),
});
export type VerificationArtifact = z.infer<typeof VerificationArtifactSchema>;

export const SubnetVerificationArtifactSchema = ArtifactBaseSchema.extend({
  candidate_count: z.int().min(0),
  netuid: z.int().min(0),
  slug: z.string(),
  name: z.string().nullable(),
  summary: VerificationSummaryBaseSchema,
  results: z.array(VerificationResultSchema),
});
export type SubnetVerificationArtifact = z.infer<
  typeof SubnetVerificationArtifactSchema
>;
