// /metagraph/r2-manifest.json -> R2ManifestArtifact + R2ManifestEntry (#9830).
//
// The publish lockfile: which artifacts exist, their content hashes, and
// where each one lives in the archive bucket. No REST route serves it (see
// the sibling surface-aliases.ts header for why these live under artifacts/).
//
// TWO producers write this path and they must agree on shape:
//   - scripts/build-artifacts.ts's buildR2Manifest() -- the build-time copy,
//     which additionally carries `history_policy`.
//   - scripts/r2-manifest.ts's buildFullManifest()/buildCompactManifest() --
//     the publish-time copy, which is what actually lands on main and in R2.
// The compact manifest drops the r2-tier entries from `artifacts` and adds
// the eight `full_*`/`storage_tier_*`/`required_artifact_paths`/
// `manifest_kind` fields that let a reader see what was omitted.
//
// EIGHT PUBLISHED FIELDS WERE UNDECLARED by the hand-written component this
// replaces -- every field the compact manifest adds. The committed artifact
// IS a compact manifest, so the published contract described 7 of the 18
// fields actually being served, and a reader could not tell a compact
// manifest from a full one or discover that `artifact_count` counts a
// filtered subset. Declared here, all optional, because the full manifest
// legitimately carries none of them.
import { z } from "zod";
import { ArtifactBaseSchema, CountMapSchema } from "../envelope.ts";

export const R2ManifestEntrySchema = z
  .object({
    content_type: z.string(),
    key: z
      .string()
      .describe(
        "Content-addressed archive key (`by-hash/<sha256>`), not run-prefixed (#8208) -- the same bytes published twice are stored once.",
      ),
    latest_key: z.string(),
    path: z
      .string()
      .regex(/^\/metagraph\//)
      .describe("Public artifact path this entry publishes."),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size_bytes: z.int().min(0),
    storage_tier: z.enum(["dual", "git", "r2"]),
  })
  .strict();
export type R2ManifestEntry = z.infer<typeof R2ManifestEntrySchema>;

const R2ManifestHistoryPolicySchema = z
  .object({
    canonical_latest_in_repo: z.boolean(),
    large_history_in_r2: z.boolean(),
    source_of_truth: z.string(),
    content_addressed_history: z.boolean(),
    manifest_run_prefix: z.string(),
  })
  .passthrough();

export const R2ManifestArtifactSchema = ArtifactBaseSchema.extend({
  artifact_count: z
    .int()
    .min(0)
    .describe(
      "Entries in THIS manifest's `artifacts`. On a compact manifest that is the git/dual subset, not the whole archive -- read `full_artifact_count` for that.",
    ),
  artifact_size_bytes: z.int().min(0),
  artifacts: z.array(R2ManifestEntrySchema),
  bucket_binding: z.string(),
  bucket_name: z.string(),
  latest_prefix: z.string(),
  run_prefix: z.string(),
  // Build-time copy only.
  history_policy: R2ManifestHistoryPolicySchema.optional(),
  // Compact-manifest fields (scripts/r2-manifest.ts's buildCompactManifest).
  manifest_kind: z
    .enum(["compact", "full"])
    .optional()
    .describe(
      "`compact` means the r2-tier entries were filtered out of `artifacts`; `full` means every entry is present. Absent on the build-time copy, which is always full.",
    ),
  full_manifest_key: z.string().optional(),
  full_manifest_run_key: z.string().optional(),
  full_artifact_count: z
    .int()
    .min(0)
    .optional()
    .describe("Entries in the full manifest this compact one was cut from."),
  full_artifact_size_bytes: z.int().min(0).optional(),
  required_artifact_paths: z
    .array(z.string())
    .optional()
    .describe(
      "Artifact paths the publish step must find in the archive even though the compact manifest omits them.",
    ),
  storage_tier_counts: CountMapSchema.optional().describe(
    "Full-manifest entry counts keyed by storage tier -- a typed record, so a new tier adds a key rather than changing the contract.",
  ),
  storage_tier_size_bytes: CountMapSchema.optional(),
});
export type R2ManifestArtifact = z.infer<typeof R2ManifestArtifactSchema>;
