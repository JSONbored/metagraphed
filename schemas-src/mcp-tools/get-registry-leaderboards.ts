// MCP tool `get_registry_leaderboards` (types-epic E batch 4, #8067). Mirrors
// GET /api/v1/registry/leaderboards, which is not one of schemas-src/routes/'s
// covered pilot routes -- no existing Zod schema to reuse. Modeled fresh,
// shallow, from the hand-written literal it replaces. Board enum hardcoded
// from src/health-serving.ts's LEADERBOARD_BOARDS (base 6 boards +
// ECONOMIC_BOARD_SPECS's 6 keys) at the time of writing.
import { z } from "zod";
import { OpenObjectSchema, limitSchema } from "./shared.ts";

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

export const GetRegistryLeaderboardsInputSchema = z
  .object({
    board: z
      .enum(LEADERBOARD_BOARDS)
      .optional()
      .describe("Which leaderboard to return.")
      .meta({ examples: [LEADERBOARD_BOARDS[0]] }),
    limit: limitSchema(100).optional(),
  })
  .strict();
export type GetRegistryLeaderboardsInput = z.infer<
  typeof GetRegistryLeaderboardsInputSchema
>;

export const GetRegistryLeaderboardsOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    board: z.string().nullable().optional(),
    observed_at: z.string().nullable().optional(),
    boards: OpenObjectSchema,
  })
  .passthrough();
export type GetRegistryLeaderboardsOutput = z.infer<
  typeof GetRegistryLeaderboardsOutputSchema
>;
