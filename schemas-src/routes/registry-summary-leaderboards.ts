// GET /api/v1/registry/summary, GET /api/v1/registry/leaderboards
// (types-epic B batch 8, #8062). registry_summary (types-epic E batch 11,
// #8074's registry-summary-gaps.ts) mirrors GET /api/v1/registry/summary
// and confirms it's a no-input, baked-artifact passthrough route.
// GET /api/v1/registry/leaderboards is live-composed (composeLeaderboardsData)
// -- its `board` enum (LEADERBOARD_BOARDS, src/health-serving.ts) is a
// superset of find_subnet_opportunities' ECONOMIC_LEADERBOARD_BOARDS
// (types-epic E batch 12, #8076's ai-discovery.ts): 6 operational boards
// (healthiest/fastest-rpc/most-complete/most-enriched/fastest-growing/
// most-reliable, "always empty now" per D1 elimination but still valid
// `?board=` values) plus the same 6 economic boards. Modeled from the
// hand-edited RegistrySummaryArtifact/RegistryLeaderboardsArtifact
// components they replace.
import { z } from "zod";
import { ArtifactBaseSchema, CountMapSchema } from "../envelope.ts";
import { CoverageCompletenessSchema } from "./coverage.ts";

export const RegistrySummaryArtifactSchema = ArtifactBaseSchema.extend({
  subnet_count: z.int().min(0),
  // The completeness block from GET /api/v1/coverage, not a restatement of it
  // (#9800). This was a bare open object, so the headline coverage figure the
  // registry summary exists to report told a reader nothing about its own shape.
  coverage: CoverageCompletenessSchema.nullable().optional(),
  counts: z
    .object({
      surfaces: z.int().min(0),
      endpoints: z.int().min(0),
      providers: z.int().min(0),
      candidates: z.int().min(0),
    })
    .passthrough(),
  curation_level_counts: CountMapSchema.optional(),
  profile_level_counts: CountMapSchema.optional(),
  top_subnets: z.array(
    z
      .object({
        netuid: z.int().min(0),
        slug: z.string().optional(),
        name: z.string().optional(),
        completeness_score: z.number(),
        profile_level: z.string().optional(),
        curation_level: z.string().optional(),
      })
      .passthrough(),
  ),
  // #9800. Was a bare open object; this is the publish-time diff summary, and
  // the counts inside it are the whole point of the field.
  recent_changes: z
    .object({
      generated_at: z.string().nullable().optional(),
      artifacts: z
        .object({
          added: z.int().min(0).optional(),
          modified: z.int().min(0).optional(),
          removed: z.int().min(0).optional(),
        })
        .passthrough()
        .optional(),
      subnets: z
        .object({
          added: z.int().min(0).optional(),
          removed: z.int().min(0).optional(),
          renamed: z.int().min(0).optional(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough()
    .optional(),
}).passthrough();
export type RegistrySummaryArtifact = z.infer<
  typeof RegistrySummaryArtifactSchema
>;

export const ECONOMIC_LEADERBOARD_BOARDS = [
  "open-slots",
  "cheapest-registration",
  "highest-emission",
  "validator-headroom",
  "biggest-alpha-gain-1d",
  "biggest-alpha-gain-7d",
] as const;

/** One row of one leaderboard. `netuid`/`slug`/`name` identify the subnet on
 * every board; everything after that is the metric the board it came from
 * ranks by, so each is optional and only the relevant handful is present on
 * any given row. `.passthrough()` because a new board brings its own metric
 * and must not be rejected by a contract written before it existed. */
const LeaderboardEntrySchema = z
  .object({
    netuid: z.int().min(0),
    slug: z.string(),
    name: z.string().nullable(),
    // healthiest / most-reliable
    uptime_ratio: z.number().min(0).max(1).nullable().optional(),
    surfaces_ok: z.int().min(0).optional(),
    surfaces_total: z.int().min(0).optional(),
    avg_latency_ms: z.number().nullable().optional(),
    sample_count: z.int().min(0).optional(),
    latency_sample_count: z.int().min(0).optional(),
    score: z.number().nullable().optional(),
    grade: z.string().nullable().optional(),
    // fastest-rpc
    latency_ms: z.number().nullable().optional(),
    // most-complete / fastest-growing / most-enriched
    completeness_score: z.int().min(0).max(100).nullable().optional(),
    completeness_delta: z.number().nullable().optional(),
    surface_count: z.int().min(0).optional(),
    operational_interface_count: z.int().min(0).optional(),
    // open-slots / cheapest-registration
    open_slots: z.int().min(0).nullable().optional(),
    max_uids: z.int().min(0).nullable().optional(),
    registration_cost_tao: z.number().nullable().optional(),
    registration_allowed: z.boolean().nullable().optional(),
    // highest-emission / validator-headroom
    tao_in_emission_tao: z.number().nullable().optional(),
    emission_share: z.number().nullable().optional(),
    emission_enabled: z.boolean().nullable().optional(),
    total_stake_alpha: z.number().nullable().optional(),
    validator_count: z.int().min(0).nullable().optional(),
    miner_count: z.int().min(0).nullable().optional(),
    validator_headroom: z.int().nullable().optional(),
    max_validators: z.int().min(0).nullable().optional(),
    // biggest-alpha-gain-1d / -7d
    alpha_price_tao: z.number().nullable().optional(),
    alpha_price_change_1d: z.number().nullable().optional(),
    alpha_price_change_7d: z.number().nullable().optional(),
  })
  .passthrough();

export const RegistryLeaderboardsArtifactSchema = z
  .object({
    schema_version: z.int(),
    board: z
      .string()
      .nullable()
      .optional()
      .describe(
        "The board filter that was applied, or null when every board is returned.",
      ),
    observed_at: z.string().nullable().optional(),
    source: z.string(),
    // Keyed by board name (LEADERBOARD_BOARDS), which is a typed record. The
    // ENTRY was the untyped half of it (#9800): every board's rows share the
    // same three identity fields and then carry the metric that board ranks
    // by, so the union below is a real description rather than a shrug.
    // Modeled from all twelve boards' live rows.
    boards: z
      .record(z.string(), z.array(LeaderboardEntrySchema))
      .describe(
        "Every board keyed by board name, each an array of ranked subnet entries capped at limit. Opaque JSON like HealthTrends.windows: the keys are dynamic AND hyphenated (fastest-rpc, most-complete, open-slots, …) so they are not expressible as GraphQL field names, and each board carries its own metric columns (healthiest has uptime_ratio/surfaces_ok, fastest-rpc has latency_ms, fastest-growing has completeness_delta, …). Passing it through verbatim keeps the REST/MCP get_registry_leaderboards shape byte-for-byte.",
      ),
  })
  .passthrough()
  .describe(
    "Registry leaderboards over the operational + economic-opportunity boards. Mirrors GET /api/v1/registry/leaderboards.",
  );
export type RegistryLeaderboardsArtifact = z.infer<
  typeof RegistryLeaderboardsArtifactSchema
>;
