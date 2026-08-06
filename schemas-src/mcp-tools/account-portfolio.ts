// MCP tools `get_account_portfolio`, `get_account_positions`,
// `get_account_snapshot` (types-epic E batch 6, #8069). Each mirrors a
// GET /api/v1/accounts/{ss58}/{portfolio,positions} route (get_account_snapshot
// has no REST equivalent -- it fans out to five other tools' own live loaders
// in one call), none of which are covered by schemas-src/routes/ -- no
// existing Zod schema to reuse. get_account_snapshot's balance/portfolio/
// subnets/positions/recent_events fields are deliberately bare open objects,
// NOT the sibling tools' own precise output schemas from this same batch --
// the hand-written original never nested their real shapes either (bare
// {type:"object"}), so reusing them here would be a real tightening the
// issue's wire-compatibility constraint doesn't require.
import { z } from "zod";
import {
  OpenObjectArraySchema,
  OpenObjectSchema,
  ss58Schema,
} from "./shared.ts";

export const GetAccountPortfolioInputSchema = z
  .object({
    ss58: ss58Schema(),
  })
  .strict();
export type GetAccountPortfolioInput = z.infer<
  typeof GetAccountPortfolioInputSchema
>;

export const GetAccountPortfolioOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    ss58: z.string(),
    captured_at: z.string().nullable().optional(),
    subnet_count: z.int().optional(),
    position_count: z.int(),
    validator_count: z.int().optional(),
    miner_count: z.int().optional(),
    total_stake_tao: z.number().optional(),
    total_emission_tao: z.number().optional(),
    overall_yield: z.number().nullable().optional(),
    stake_concentration: OpenObjectSchema.nullable().optional(),
    positions: OpenObjectArraySchema,
  })
  .passthrough();
export type GetAccountPortfolioOutput = z.infer<
  typeof GetAccountPortfolioOutputSchema
>;

export const GetAccountPositionsInputSchema = z
  .object({
    ss58: ss58Schema(),
  })
  .strict();
export type GetAccountPositionsInput = z.infer<
  typeof GetAccountPositionsInputSchema
>;

export const GetAccountPositionsOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    ss58: z.string(),
    captured_at: z.string().nullable().optional(),
    position_count: z.int(),
    total_stake_tao: z.number(),
    positions: OpenObjectArraySchema,
  })
  .passthrough();
export type GetAccountPositionsOutput = z.infer<
  typeof GetAccountPositionsOutputSchema
>;

export const GetAccountSnapshotInputSchema = z
  .object({
    ss58: ss58Schema(),
    recent_events_limit: z
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe(
        "How many recent events to embed. Clamped to the tool's ceiling rather than rejected.",
      )
      .meta({ examples: [10] }),
  })
  .strict();
export type GetAccountSnapshotInput = z.infer<
  typeof GetAccountSnapshotInputSchema
>;

export const GetAccountSnapshotOutputSchema = z
  .object({
    ss58: z.string(),
    balance: OpenObjectSchema,
    portfolio: OpenObjectSchema,
    subnets: OpenObjectSchema,
    positions: OpenObjectSchema,
    recent_events: OpenObjectSchema,
  })
  .passthrough();
export type GetAccountSnapshotOutput = z.infer<
  typeof GetAccountSnapshotOutputSchema
>;
