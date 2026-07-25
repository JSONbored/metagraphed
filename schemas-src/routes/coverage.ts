// GET /api/v1/coverage, GET /api/v1/coverage-depth (types-epic B batch 8,
// #8062). Both no-input, baked-artifact passthrough routes (mirror the
// get_coverage/get_coverage_depth MCP tools, types-epic E batch 11,
// #8074's meta-artifacts-2.ts). Modeled from the hand-edited
// CoverageArtifact/CoverageDepthArtifact(+Row/QueueEntry) components they
// replace.
import { z } from "zod";
import {
  ArtifactBaseSchema,
  CountMapSchema,
  successEnvelopeSchema,
} from "../envelope.ts";
import { BittensorNetworkSchema } from "../shared.ts";

const CoverageCompletenessSchema = z
  .object({
    scored_subnet_count: z.int().min(0).optional(),
    average_score: z.int().min(0).max(100).optional(),
    median_score: z.int().min(0).max(100).optional(),
    fully_complete_count: z.int().min(0).optional(),
    fully_complete_pct: z.int().min(0).max(100).optional(),
    score_distribution: z.record(z.string(), z.int().min(0)).optional(),
    dimension_coverage: z
      .record(z.string(), z.object({}).passthrough())
      .optional(),
    methodology: z.string().optional(),
  })
  .passthrough()
  .optional();

const CoverageSourceSchema = z
  .object({
    candidates: z.string(),
    native: z.union([z.string(), z.object({}).passthrough()]),
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
  manifested_count: z.int().min(0),
  native_only_count: z.int().min(0),
  native_only_with_candidates: z.int().min(0),
  native_only_without_candidates: z.int().min(0),
  native_snapshot_captured_at: z.string(),
  network: BittensorNetworkSchema,
  probed_count: z.int().min(0),
  probed_surface_count: z.int().min(0),
  root_subnet_count: z.int().min(0),
  source: CoverageSourceSchema,
  surface_count: z.int().min(0),
}).passthrough();
export type CoverageArtifact = z.infer<typeof CoverageArtifactSchema>;
export const CoverageResponseSchema = successEnvelopeSchema(
  CoverageArtifactSchema,
);

// Shared with schemas-src/mcp-tools/registry-summary-gaps.ts's
// COVERAGE_DEPTH_TIERS/COVERAGE_DEPTH_SEVERITIES (types-epic E batch 11,
// #8074) -- symbolic in the hand-written original (mcp-server.ts's own
// COVERAGE_DEPTH_TIERS/COVERAGE_DEPTH_SEVERITIES constants), cross-checked
// against the actual runtime source at the time of writing.
const COVERAGE_DEPTH_TIERS = [
  "agent-ready",
  "machine-usable",
  "candidate-review",
  "needs-evidence",
  "hard-blocked",
  "missing-interface",
] as const;
const COVERAGE_DEPTH_SEVERITIES = [
  "hard",
  "missing-data",
  "needs-review",
] as const;
const AGENT_READINESS_STATUSES = [
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

const CoverageDepthDimensionsSchema = z
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
  .passthrough();

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
    blocker_level: z.enum([
      "none",
      "hard-blocked",
      "needs-review",
      "missing-data",
    ]),
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
    .passthrough(),
  rows: z.array(CoverageDepthRowSchema),
  ranked_queue: z.array(CoverageDepthQueueEntrySchema),
}).passthrough();
export type CoverageDepthArtifact = z.infer<typeof CoverageDepthArtifactSchema>;
export const CoverageDepthResponseSchema = successEnvelopeSchema(
  CoverageDepthArtifactSchema,
);
