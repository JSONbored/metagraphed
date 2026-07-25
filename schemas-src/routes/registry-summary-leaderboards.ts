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
import {
  ArtifactBaseSchema,
  CountMapSchema,
  successEnvelopeSchema,
} from "../envelope.ts";

export const RegistrySummaryArtifactSchema = ArtifactBaseSchema.extend({
  subnet_count: z.int().min(0),
  coverage: z.object({}).passthrough().nullable().optional(),
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
  recent_changes: z.object({}).passthrough().optional(),
}).passthrough();
export type RegistrySummaryArtifact = z.infer<
  typeof RegistrySummaryArtifactSchema
>;
export const RegistrySummaryResponseSchema = successEnvelopeSchema(
  RegistrySummaryArtifactSchema,
);

const ECONOMIC_LEADERBOARD_BOARDS = [
  "open-slots",
  "cheapest-registration",
  "highest-emission",
  "validator-headroom",
  "biggest-alpha-gain-1d",
  "biggest-alpha-gain-7d",
] as const;
const LEADERBOARD_BOARDS = [
  "healthiest",
  "fastest-rpc",
  "most-complete",
  "most-enriched",
  "fastest-growing",
  "most-reliable",
  ...ECONOMIC_LEADERBOARD_BOARDS,
] as const;

export const RegistryLeaderboardsQuerySchema = z
  .object({
    board: z.enum(LEADERBOARD_BOARDS).optional(),
    limit: z.int().min(1).max(100).optional(),
  })
  .strict();
export type RegistryLeaderboardsQuery = z.infer<
  typeof RegistryLeaderboardsQuerySchema
>;

export const RegistryLeaderboardsArtifactSchema = z
  .object({
    schema_version: z.int(),
    board: z.string().nullable().optional(),
    observed_at: z.string().nullable().optional(),
    source: z.string(),
    boards: z.record(z.string(), z.array(z.object({}).passthrough())),
  })
  .passthrough();
export type RegistryLeaderboardsArtifact = z.infer<
  typeof RegistryLeaderboardsArtifactSchema
>;
export const RegistryLeaderboardsResponseSchema = successEnvelopeSchema(
  RegistryLeaderboardsArtifactSchema,
);
