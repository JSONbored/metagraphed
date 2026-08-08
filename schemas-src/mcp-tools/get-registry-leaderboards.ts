// MCP tool `get_registry_leaderboards`.
// Mirrors GET /api/v1/registry/leaderboards.
//
// DERIVED FROM THE ROUTE, NOT COPIED (#9796). Each output schema below IS the
// route's own ArtifactSchema, so a route field rename is a compile error here
// instead of silent production drift -- which is what the hand-written copies
// this replaces had already accumulated.
//
// What the copies were publishing:
//   get_registry_leaderboards: 1 bare `{"type":"object"}` site.
//
// Verified against production before the switch, because deriving is a
// TIGHTENING -- the route schema is stricter than the copy was. Every tool in
// this file was called live and its response validated against the schema it
// now publishes.
import { z } from "zod";
import { ROUTE_QUERY_SCHEMAS } from "../route-queries.ts";
import { RegistryLeaderboardsArtifactSchema } from "../routes/registry-summary-leaderboards.ts";

const LEADERBOARD_BOARDS = [
  "healthiest",
  "fastest-rpc",
  "most-complete",
  "most-enriched",
  "fastest-growing",
  "most-reliable",
  "open-slots",
  "cheapest-registration",
  "highest-emission",
  "validator-headroom",
  "biggest-alpha-gain-1d",
  "biggest-alpha-gain-7d",
] as const;

const RouteQuery_registry_leaderboards =
  ROUTE_QUERY_SCHEMAS["/api/v1/registry/leaderboards"];

export const GetRegistryLeaderboardsInputSchema = z
  .object({
    board: RouteQuery_registry_leaderboards.shape.board
      .describe("Which leaderboard to return.")
      .meta({ examples: [LEADERBOARD_BOARDS[0]] }),
    limit: RouteQuery_registry_leaderboards.shape.limit.meta({ default: 20 }),
  })
  .strict();
export type GetRegistryLeaderboardsInput = z.infer<
  typeof GetRegistryLeaderboardsInputSchema
>;

export const GetRegistryLeaderboardsOutputSchema =
  RegistryLeaderboardsArtifactSchema;
export type GetRegistryLeaderboardsOutput = z.infer<
  typeof GetRegistryLeaderboardsOutputSchema
>;
