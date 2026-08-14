// GET /api/v1/subnets (types-epic A pilot route #1 of 5, #7859) — list +
// pagination envelope variant.
//
// Data shape (SubnetsArtifact) derived by reading public/metagraph/
// openapi.json's SubnetsArtifact/SubnetIndexEntry components (built from
// src/contracts.ts) and cross-checked against the real handler response
// (handleRequest() dispatch through workers/api.ts, served via
// workers/responses.ts's envelopeResponse) — see tests/zod-schemas.test.ts.
// Query params from the same OpenAPI operation's `parameters` array (the
// route() call in src/contracts.ts for "subnets").
import { z } from "zod";
import { LineageAlsoOnEntrySchema } from "./subnet-profile.ts";
import { GpuRequirementSchema } from "../compute.ts";
import {
  SocialLinksSchema,
  GithubReleaseSchema,
  NativeSnapshotSourceSchema,
} from "../shared.ts";
import { ArtifactBaseSchema } from "../envelope.ts";
import {
  BittensorNetworkSchema,
  CoverageLevelSchema,
  CurationLevelSchema,
  PartnershipMetadataSchema,
  SubnetStatusSchema,
  SubnetTypeSchema,
} from "../shared.ts";
import { NATIVE_NAME_QUALITY_VALUES } from "../shared.ts";

export const SubnetIndexEntrySchema = z
  .object({
    block: z.int().min(0).optional(),
    candidate_count: z.int().min(0).optional(),
    categories: z.array(z.string()).optional(),
    contact: z.string().nullable().optional(),
    contact_present: z.boolean().optional(),
    coverage_level: CoverageLevelSchema,
    curation_level: CurationLevelSchema,
    // format:"uri" in the hand-edited OpenAPI contract -- z.url() matches it
    // exactly (verified against every registry/subnets/*.json value before
    // adding this constraint, #7860's diff audit).
    dashboard_url: z.url().nullable().optional(),
    derived_categories: z.array(z.string()).optional(),
    derived_description: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    discord: z.string().max(200).nullable().optional(),
    discord_url: z.url().nullable().optional(),
    docs_url: z.url().nullable().optional(),
    first_party: z.boolean().optional(),
    gap_count: z.int().min(0).optional(),
    // #8379: last 13 weeks (~90d) of commit activity for the resolved
    // source_repo, from GitHub's stats/commit_activity endpoint.
    github_commits_weekly: z
      .array(z.object({ week: z.iso.datetime(), count: z.int().min(0) }))
      .nullable()
      .optional(),
    // #11097: the miner hardware floor this subnet's own min_compute.yml
    // declares, in bulk, because "does it need a GPU" is the first screening
    // filter a capital-constrained operator applies and answering it used to
    // mean opening 129 repos by hand. Null on the 90 subnets whose resolved
    // source repo publishes no readable file -- never a guessed `false`. The
    // whole declaration, both roles and its citation, is the
    // `compute_requirements` section on /subnets/{netuid}/overview.
    gpu_required: GpuRequirementSchema.nullable().optional(),
    min_vram_gb: z.number().nullable().optional(),
    // #11099: the testnet lineage in bulk (the profile's also_on list) -- a
    // screen can name the free practice netuids for every candidate in one
    // call. Null when no testnet twin matched.
    also_on: z.array(LineageAlsoOnEntrySchema).nullable().optional(),
    // Byte-count language breakdown from the GitHub /languages API (#6639) —
    // a genuinely open map (language name -> byte count), matching the
    // OpenAPI contract's own additionalProperties schema, not a shortcut.
    github_languages: z
      .record(z.string(), z.int().min(0))
      .nullable()
      .optional(),
    // format:"date-time" in the hand-edited contract -- z.iso.datetime()
    // matches it (same verification as dashboard_url above).
    github_last_push_at: z.iso.datetime().nullable().optional(),
    github_stars: z.int().min(0).nullable().optional(),
    // #8379: true when the last capture attempt failed and this is retained
    // last-good data (dropped from the artifact entirely, not flagged, once
    // stale beyond 30d) -- see registry/generated/github-signals.json.
    // #8704: the subnet repo's published releases, feeding the `release` item
    // kind on /api/v1/feeds/subnets/{netuid}. Null means the repo was never
    // asked (no resolvable source repo, or not yet captured); [] means it
    // publishes no releases, which is the common case for subnet repos.
    github_releases: z.array(GithubReleaseSchema).nullable().optional(),
    github_unreachable: z.boolean().optional(),
    integration_readiness: z.int().min(0).max(100).optional(),
    lifecycle: z.enum(["active", "deprecated", "parked", "pending"]).optional(),
    logo_url: z.url().nullable().optional(),
    mechanism_count: z.int().min(0).optional(),
    name: z.string(),
    native_name: z.string().nullable().optional(),
    native_name_quality: z.enum(NATIVE_NAME_QUALITY_VALUES).optional(),
    native_slug: z.string().nullable().optional(),
    netuid: z.int().min(0),
    official_surface_count: z.int().min(0).optional(),
    participant_count: z.int().min(0).optional(),
    partnership: PartnershipMetadataSchema.nullable().optional(),
    probed_surface_count: z.int().min(0).optional(),
    registered_at_block: z.int().min(0).optional(),
    registry_observed_count: z.int().min(0).optional(),
    slug: z.string(),
    social: SocialLinksSchema.nullable().optional(),
    source_repo: z.url().nullable().optional(),
    status: SubnetStatusSchema,
    subnet_type: SubnetTypeSchema,
    surface_count: z.int().min(0),
    symbol: z.string().nullable().optional(),
    tempo: z.int().min(0).optional(),
    updated_at: z.iso.datetime().nullable().optional(),
    website_url: z.url().nullable().optional(),
  })
  .strict();
export type SubnetIndexEntry = z.infer<typeof SubnetIndexEntrySchema>;

export const SubnetsArtifactSchema = ArtifactBaseSchema.extend({
  network: BittensorNetworkSchema,
  // The chain snapshot's OWN capture stamp, distinct from `generated_at` (this
  // build's marker). Both `subnets.json` and `metagraph/latest.json` have
  // carried it since the native snapshot landed, and neither schema declared it
  // -- the same class as `SubnetUptime.observed_at` (#10761), found the same
  // way (#10790).
  captured_at: z
    .string()
    .nullable()
    .optional()
    .describe(
      "When the chain snapshot behind this index was captured. Distinct from `generated_at`, which marks the build that shaped it.",
    ),
  native_snapshot_captured_at: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Capture stamp of the native (SDK) snapshot the identity overlay was merged onto.",
    ),
  source: NativeSnapshotSourceSchema,
  subnets: z.array(SubnetIndexEntrySchema),
});
export type SubnetsArtifact = z.infer<typeof SubnetsArtifactSchema>;
