// The two health artifacts that no REST route serves (#9830):
//   /metagraph/health/latest.json          -> HealthLatestArtifact  (RETIRED)
//   /metagraph/health/badges/{netuid}.json -> HealthBadgeArtifact
// See the sibling surface-aliases.ts header for why these live under
// artifacts/ rather than routes/.
//
// HealthLatestArtifact is a RETIRED contract (`status: "retired"` in
// contracts.json) and is deliberately still published. The build stopped
// writing health/latest.json when health went live-only -- the 15-minute cron
// is the single source of truth now, and /api/v1/health serves from KV rather
// than a baked artifact, reporting `unknown` when the live store is cold
// instead of a possibly-stale value. The component stays because consumers
// pinned to it must keep resolving; it is modeled from the `latest` object
// buildHealthArtifacts() still computes for the build's own internal
// derivations.
//
// FOUR PUBLISHED FIELDS WERE UNDECLARED on HealthLatestArtifact:
// `source`, `probe_started_at`, `probe_finished_at`, and
// `summary.classification_counts`. #9831 typed `summary` but declared only
// two of its three keys -- `classification_counts` is emitted by the same
// object literal as the other two and was missed. THREE were undeclared on
// HealthBadgeArtifact: `ok_count`, `failed_count`, `unknown_count` -- the
// counts behind the badge's own verdict.
import { z } from "zod";
import { ArtifactBaseSchema, CountMapSchema } from "../envelope.ts";
import { HealthStatusSchema } from "../shared.ts";
import { HealthSurfaceSchema } from "../routes/health-surfaces.ts";

const HealthLatestSummarySchema = z
  .object({
    surface_count: z.int().min(0),
    // Keyed by health verdict / classification, so a new verdict adds a key
    // rather than changing the contract -- a typed record, not opacity.
    status_counts: CountMapSchema,
    classification_counts: CountMapSchema,
  })
  .strict();

export const HealthLatestArtifactSchema = ArtifactBaseSchema.extend({
  observed_at: z
    .string()
    .meta({ format: "date-time" })
    .nullable()
    .describe(
      "When the probe run that produced this rollup finished -- `probe_finished_at || observed_at || null`, not the build's `generated_at`.",
    ),
  source: z.string().optional(),
  probe_started_at: z.string().nullable().optional(),
  probe_finished_at: z.string().nullable().optional(),
  summary: HealthLatestSummarySchema.describe(
    "Network-wide health rollup for this observation. `status_counts` and `classification_counts` are keyed by verdict, so a new verdict adds a key rather than changing the contract -- typed records, not opacity.",
  ),
  surfaces: z.array(HealthSurfaceSchema),
});
export type HealthLatestArtifact = z.infer<typeof HealthLatestArtifactSchema>;

export const HealthBadgeArtifactSchema = ArtifactBaseSchema.extend({
  netuid: z.int().min(0),
  label: z.string().describe("Badge left-hand text, always `SN<netuid>`."),
  message: z
    .string()
    .describe(
      "Badge right-hand text. Currently the same value as `status`, kept separate because the badge's wording is a display concern and the verdict is not.",
    ),
  status: HealthStatusSchema,
  color: z.string(),
  surface_count: z.int().min(0),
  ok_count: z.int().min(0).optional(),
  failed_count: z.int().min(0).optional(),
  unknown_count: z.int().min(0).optional(),
});
export type HealthBadgeArtifact = z.infer<typeof HealthBadgeArtifactSchema>;
