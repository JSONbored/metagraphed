// GET /api/v1/coverage, GET /api/v1/coverage-depth (types-epic B batch 8,
// #8062). Both no-input, baked-artifact passthrough routes (mirror the
// get_coverage/get_coverage_depth MCP tools, types-epic E batch 11,
// #8074's meta-artifacts-2.ts). Modeled from the hand-edited
// CoverageArtifact/CoverageDepthArtifact(+Row/QueueEntry) components they
// replace.
import { z } from "zod";
import { QUERY_ENUMS } from "../query-enums.ts";
import { ArtifactBaseSchema, CountMapSchema } from "../envelope.ts";
import {
  BittensorNetworkSchema,
  NativeSnapshotSourceSchema,
} from "../shared.ts";

/** One surface kind's share of the registry: how many subnets have it, and
 * that as a whole-number percentage. Exported because
 * RegistrySummaryArtifact embeds the same map and must not restate it. */
export const CoverageDimensionSchema = z
  .object({
    pct: z.int().min(0).max(100),
    present: z
      .int()
      .min(0)
      .describe("Subnets carrying at least one surface of this kind."),
  })
  .strict();

export const CoverageCompletenessSchema = z
  .object({
    scored_subnet_count: z.int().min(0).optional(),
    average_score: z.int().min(0).max(100).optional(),
    median_score: z.int().min(0).max(100).optional(),
    fully_complete_count: z.int().min(0).optional(),
    fully_complete_pct: z.int().min(0).max(100).optional(),
    score_distribution: z.record(z.string(), z.int().min(0)).optional(),
    // Keyed by surface kind (docs, openapi, subnet-api, …), so a new kind
    // adds a key rather than changing the contract -- a typed record. The
    // VALUE was the untyped half of it (#9800): every entry carries the same
    // two numbers, verified across all eight kinds the live artifact serves.
    dimension_coverage: z
      .record(z.string(), CoverageDimensionSchema)
      .optional(),
    methodology: z.string().optional(),
  })
  .strict()
  .optional();

const CoverageSourceSchema = z
  .object({
    candidates: z.string(),
    // #9800. The object arm was bare. It describes HOW the native identity was
    // read -- which package, which RPC family, which storage item -- which is the
    // provenance a caller needs to judge the figure. The string arm is the older
    // shorthand form and is kept for wire compatibility.
    native: z.union([z.string(), NativeSnapshotSourceSchema]),
    overlays: z.string(),
  })
  .strict();

export const CoverageArtifactSchema = ArtifactBaseSchema.extend({
  application_subnet_count: z.int().min(0),
  candidate_count: z.int().min(0),
  candidate_subnet_count: z.int().min(0),
  chain_subnet_count: z.int().min(0),
  completeness: CoverageCompletenessSchema,
  curated_overlay_count: z.int().min(0),
  curation_level_counts: CountMapSchema,
  // #10214: served by /api/v1/build and /api/v1/coverage all along, declared
  // nowhere. The artifact is `.passthrough()`, so they reached a caller while
  // the contract said nothing about them -- invisible until this component was
  // published as a GraphQL type and the emitted shape could be compared
  // field-for-field against what production returns.
  //
  // The registry-derived counts are OPTIONAL, not required (#10965): the
  // registry (surfaces, curation, domains) is mainnet-only, so the testnet
  // build has nothing to count and its artifact omits these five keys --
  // measured on the served testnet document, which the response tripwire now
  // actually validates. Requiring them made the published contract refuse a
  // response the builder is right to produce.
  domain_coverage: CountMapSchema.optional(),
  first_party_subnet_count: z.int().min(0).optional(),
  manifested_count: z.int().min(0),
  native_only_count: z.int().min(0),
  native_only_with_candidates: z.int().min(0),
  native_only_without_candidates: z.int().min(0),
  native_snapshot_captured_at: z.string(),
  network: BittensorNetworkSchema,
  probed_count: z.int().min(0),
  probed_surface_count: z.int().min(0),
  official_surface_count: z.int().min(0).optional(),
  registry_observed_surface_count: z.int().min(0).optional(),
  root_subnet_count: z.int().min(0),
  source: CoverageSourceSchema,
  subnets_without_official_surface: z.int().min(0).optional(),
  surface_count: z.int().min(0),
}).strict();
export type CoverageArtifact = z.infer<typeof CoverageArtifactSchema>;

// Shared with schemas-src/mcp-tools/registry-summary-gaps.ts's
// COVERAGE_DEPTH_TIERS/COVERAGE_DEPTH_SEVERITIES (types-epic E batch 11,
// #8074) -- symbolic in the hand-written original (mcp-server.ts's own
// COVERAGE_DEPTH_TIERS/COVERAGE_DEPTH_SEVERITIES constants), cross-checked
// against the actual runtime source at the time of writing.
export const COVERAGE_DEPTH_TIERS = QUERY_ENUMS.coverageDepthTier;
export const COVERAGE_DEPTH_SEVERITIES = [
  "hard",
  "missing-data",
  "needs-review",
] as const;
/**
 * How badly a subnet is blocked, single-sourced (#10011).
 *
 * Declared inline until now while the two sibling fields on the same row --
 * `tier` and `agent_status` -- were already exported, so the MCP side could
 * name those two and not this one. API_QUERY_COLLECTIONS["coverage-depth"]
 * declares the same four as a filter.
 */
export const BLOCKER_LEVELS = [
  "none",
  "hard-blocked",
  "needs-review",
  "missing-data",
] as const;

export const AGENT_READINESS_STATUSES = [
  "callable",
  "base-layer",
  "candidate",
  "needs-evidence",
  "blocked",
] as const;

export const AgentReadinessBlockerSchema = z
  .object({
    code: z.string(),
    severity: z.enum(COVERAGE_DEPTH_SEVERITIES),
    message: z.string(),
    field: z.string(),
    next_action: z.string(),
  })
  .strict();

export const CoverageDepthDimensionsSchema = z
  .object({
    surface_count: z.int().min(0),
    official_surface_count: z.int().min(0),
    registry_observed_surface_count: z.int().min(0),
    provider_claimed_surface_count: z.int().min(0),
    service_count: z.int().min(0),
    callable_service_count: z.int().min(0),
    service_kinds: z.array(z.string()),
    schema_service_count: z.int().min(0),
    schema_missing_count: z.int().min(0),
    fixture_available_count: z.int().min(0),
    fixture_status_counts: z.record(z.string(), z.int().min(0)),
    example_count: z.int().min(0),
    sdk_count: z.int().min(0),
    candidate_count: z.int().min(0),
    candidate_operational_count: z.int().min(0),
    data_artifact_count: z.int().min(0),
    source_repo_present: z.boolean(),
    docs_url_present: z.boolean(),
  })
  .strict();

export const CoverageDepthRowSchema = z
  .object({
    netuid: z.int().min(0),
    slug: z.string(),
    name: z.string(),
    subnet_type: z.string().nullable().optional(),
    curation_level: z.string().nullable().optional(),
    profile_level: z.string().nullable().optional(),
    score: z.int().min(0).max(100),
    tier: z.enum(COVERAGE_DEPTH_TIERS),
    priority_score: z.int().min(0).max(100),
    agent_status: z.enum(AGENT_READINESS_STATUSES),
    blocker_level: z.enum(BLOCKER_LEVELS),
    readiness_score: z.int().min(0).max(100),
    completeness_score: z.number().nullable().optional(),
    dimensions: CoverageDepthDimensionsSchema,
    top_gaps: z.array(AgentReadinessBlockerSchema),
    top_gap_codes: z.array(z.string()),
    recommended_next_action: z.string().nullable(),
  })
  .strict();

export const CoverageDepthQueueEntrySchema = z
  .object({
    rank: z.int().min(1),
    netuid: z.int().min(0),
    slug: z.string(),
    name: z.string(),
    tier: z.string(),
    score: z.int().min(0).max(100),
    priority_score: z.int().min(0).max(100),
    severity: z.enum(COVERAGE_DEPTH_SEVERITIES),
    top_gap_codes: z.array(z.string()),
    recommended_next_action: z.string(),
  })
  .strict();

export const CoverageDepthArtifactSchema = ArtifactBaseSchema.extend({
  coverage_depth_version: z.int().min(1),
  subnet_count: z.int().min(0),
  summary: z
    .object({
      row_count: z.int().min(0),
      agent_ready_count: z.int().min(0),
      callable_subnet_count: z.int().min(0),
      blocked_subnet_count: z.int().min(0),
      queue_count: z.int().min(0),
      average_score: z.int().min(0).max(100),
      tier_counts: z.record(z.string(), z.int().min(0)),
      blocker_level_counts: z.record(z.string(), z.int().min(0)),
      severity_counts: z.record(z.string(), z.int().min(0)),
      gap_code_counts: z.record(z.string(), z.int().min(0)),
    })
    .strict(),
  scoring: z
    .object({
      methodology: z.string(),
      weights: z.record(z.string(), z.int().min(0).max(100)),
    })
    .strict(),
  rows: z.array(CoverageDepthRowSchema),
  ranked_queue: z.array(CoverageDepthQueueEntrySchema),
}).strict();
export type CoverageDepthArtifact = z.infer<typeof CoverageDepthArtifactSchema>;
