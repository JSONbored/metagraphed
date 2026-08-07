// /metagraph/schema-drift.json -> SchemaDriftArtifact + SchemaDriftSurface
// (#9830). Whether each subnet's published OpenAPI document still hashes to
// what was last captured. No REST route serves it (see the sibling
// surface-aliases.ts header for why these live under artifacts/).
//
// TWO producers, and the contract has to cover both:
//   - scripts/snapshot-openapi.ts writes the real one, after fetching every
//     openapi surface (`source: "openapi-snapshot"`).
//   - scripts/build-artifacts.ts writes a placeholder when no snapshot run
//     has happened (`source: "artifact-build"`, `status: "not-snapshotted"`,
//     every entry `drift_status: "not-captured"`).
//
// TWO PUBLISHED FIELDS WERE UNDECLARED by the hand-written component this
// replaces: `observed_at` (the snapshot run's own stamp, distinct from the
// build's `generated_at` -- the only field that says how old the drift
// verdict is) and `summary`. Both are emitted unconditionally by the
// snapshot producer.
import { z } from "zod";
import { ArtifactBaseSchema, CountMapSchema } from "../envelope.ts";

export const SchemaDriftSurfaceSchema = z
  .object({
    netuid: z.int().min(0),
    schema_url: z.url().nullable(),
    status: z
      .enum([
        "captured",
        "error",
        "not-found",
        "pending-snapshot",
        "too-large",
        "ui-only-or-undiscovered",
        "unsafe",
      ])
      .describe(
        "What the capture attempt found. `ui-only-or-undiscovered` means the surface declares no schema_url at all, which is a gap rather than a failure.",
      ),
    drift_status: z
      .enum([
        "changed",
        "missing-after-previous-capture",
        "new",
        "not-captured",
        "unchanged",
      ])
      .optional()
      .describe(
        "How this capture compares with the previous one. Absent only where a producer omits it.",
      ),
    subnet_slug: z.string(),
    surface_id: z.string(),
    url: z.url(),
    // Both producers set these three unconditionally, but they stay OPTIONAL
    // rather than required-but-nullable: reusableSchemaDriftArtifact()
    // republishes a previous artifact VERBATIM when the surface set has not
    // changed, so a copy written by an older build reaches consumers without
    // passing through either producer again. Requiring a field on the
    // strength of today's producer alone would publish a claim that path can
    // violate.
    hash: z.string().nullable().optional(),
    previous_hash: z.string().nullable().optional(),
    error: z.string().nullable().optional(),
  })
  .strict();
export type SchemaDriftSurface = z.infer<typeof SchemaDriftSurfaceSchema>;

const SchemaDriftSummarySchema = z
  .object({
    surface_count: z.int().min(0),
    schema_count: z.int().min(0),
    by_status: CountMapSchema,
    by_drift_status: CountMapSchema,
  })
  .passthrough();

export const SchemaDriftArtifactSchema = ArtifactBaseSchema.extend({
  openapi_surface_count: z.int().min(0),
  schema_backed_surface_count: z.int().min(0),
  source: z
    .string()
    .describe(
      "`openapi-snapshot` for a real capture run, `artifact-build` for the placeholder a build writes when no snapshot has run.",
    ),
  status: z.enum([
    "captured",
    "error",
    "not-found",
    "not-snapshotted",
    "unsafe",
  ]),
  observed_at: z
    .string()
    .nullable()
    .optional()
    .describe(
      "When the snapshot run observed these surfaces -- NOT the build's `generated_at`. A rebuild republishes an old capture unchanged, so this is the only field that says how old the drift verdict is. Absent on the build-time placeholder, which observed nothing.",
    ),
  summary: SchemaDriftSummarySchema.optional().describe(
    "Rollups from the snapshot run. Absent on the build-time placeholder.",
  ),
  surfaces: z.array(SchemaDriftSurfaceSchema),
});
export type SchemaDriftArtifact = z.infer<typeof SchemaDriftArtifactSchema>;
