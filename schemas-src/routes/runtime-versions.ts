// GET /api/v1/runtime (types-epic B batch 7, #8061). Live blocks tier
// data -- no static file. Modeled from src/runtime-versions.ts's
// buildRuntimeVersionHistory(), cross-checked against the hand-edited
// RuntimeVersionsArtifact component it replaces.
//
// RuntimeVersionTransition is intentionally NOT registered as a shared
// component -- RuntimeVersionsArtifact is its only referrer (verified via
// repo-wide $ref grep), so the hand-edited component key becomes fully
// orphaned.
import { z } from "zod";
import { GithubReleaseSchema } from "../shared.ts";

const RuntimeVersionTransitionSchema = z
  .object({
    spec_version: z.int().min(0),
    block_number: z.int().min(0),
    observed_at: z.string().nullable(),
  })
  .strict()
  .describe(
    "One runtime spec-version's first-seen block in the transition timeline.",
  );

// An interior hole in the timeline: two consecutive recorded transitions too
// far apart in block distance for any real upgrade cadence to explain, so
// upgrades between them are missing rather than absent. Distinct from the
// `coverage_from_block` floor, which can only describe a missing PREFIX.
const RuntimeCoverageGapSchema = z
  .object({
    after_spec_version: z.int().min(0),
    before_spec_version: z.int().min(0),
    after_block: z.int().min(0),
    before_block: z.int().min(0),
    block_span: z.int().min(0),
  })
  .strict();

/** One chain's live spec-version reading. */
const ChainSpecReadingSchema = z
  .object({
    network: z.string(),
    spec_version: z.int().min(0).nullable(),
    observed_at: z
      .string()
      .nullable()
      .describe(
        "When this reading was taken. Null whenever spec_version is null -- stamping a time on a failed read would imply something was successfully read at that moment.",
      ),
  })
  .strict();

/**
 * A GitHub release, plus the runtime version it shipped.
 *
 * #10790 collapsed `GithubReleaseSchema` from three hand-written copies into
 * one declaration in shared.ts. This was a fourth, and it survived because it
 * carries `spec_version` -- one extra key is enough for a key-set comparison to
 * stop seeing a copy.
 *
 * The two ways this reading is genuinely weaker are stated rather than
 * restated: `published_at` and `url` are nullable here because this release is
 * READ from the GitHub API at serve time and the read can come back empty,
 * where the shared schema describes a release already known to exist.
 */
const SubtensorReleaseSchema = GithubReleaseSchema.extend({
  spec_version: z.int().min(0),
  published_at: z.string().nullable(),
  url: z
    .string()
    .nullable()
    .describe("GitHub's own html_url -- never constructed."),
}).strict();

/**
 * The forward-looking half of GET /api/v1/runtime, undeclared until #10790.
 *
 * `buildUpgradeRadar()` has appended this block since #8702 and the route's own
 * contract prose describes it in detail -- it was documented, served, and
 * absent from the schema, which is the exact shape of the gap this issue
 * closes. Nothing rejected it because the envelope was `.passthrough()`.
 */
const UpgradeRadarSchema = z
  .object({
    mainnet: ChainSpecReadingSchema,
    testnet: ChainSpecReadingSchema,
    latest_release: SubtensorReleaseSchema.nullable(),
    pending_upgrade: z
      .enum(["none", "testnet_soaking", "released_undeployed", "unknown"])
      .describe(
        "`unknown` when a reading is missing -- deliberately NOT `none`, which is the opposite answer. No deploy date is predicted: the foundation publishes no schedule.",
      ),
    versions_behind: z
      .int()
      .min(0)
      .nullable()
      .describe(
        "How far mainnet trails the furthest-along reading, counted in spec versions rather than time. Null when mainnet itself could not be read.",
      ),
  })
  .strict();

export const RuntimeVersionsArtifactSchema = z
  .object({
    schema_version: z.int(),
    transitions: z.array(RuntimeVersionTransitionSchema),
    transition_count: z.int().min(0),
    current_spec_version: z.int().min(0).nullable(),
    coverage_from_block: z.int().min(0).nullable(),
    coverage_from_at: z.string().nullable(),
    coverage_complete: z.boolean(),
    coverage_gaps: z.array(RuntimeCoverageGapSchema),
    current: UpgradeRadarSchema.optional(),
  })
  .strict()
  .describe(
    "Site-wide runtime spec-version transition timeline. Mirrors GET /api/v1/runtime.",
  );
export type RuntimeVersionsArtifact = z.infer<
  typeof RuntimeVersionsArtifactSchema
>;
