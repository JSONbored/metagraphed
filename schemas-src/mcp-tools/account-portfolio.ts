// MCP tools `get_account_portfolio`, `get_account_positions`,
// `get_account_snapshot` (types-epic E batch 6, #8069). The first two mirror a
// GET /api/v1/accounts/{ss58}/{portfolio,positions} route; get_account_snapshot
// has no REST equivalent -- it fans out to five other tools' own live loaders in
// one call.
//
// This file's header used to claim none of these routes were "covered by
// schemas-src/routes/ -- no existing Zod schema to reuse". That stopped being
// true, and the hand-written copies were never revisited, so they drifted from
// the routes they mirror (#9794). `get_account_positions` is the sharpest case:
// #8803 renamed total_stake_tao to total_stake_alpha, the copy kept requiring
// the old name, and every response since has failed its own published contract.
import { z } from "zod";
import { AccountPortfolioArtifactSchema } from "../routes/account-portfolio.ts";
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

// The tool serves the route's artifact unchanged, so it publishes the route's
// schema unchanged. This is a strict improvement for callers as well as a drift
// fix: the copy declared `positions` as a bare open array and
// `stake_concentration` as a bare open object, so an agent was told nothing
// about either. The route schema types every position and carries the
// descriptions that matter for reading the numbers correctly -- that the totals
// are genuine TAO converted through each subnet's SPOT price rather than a sum
// of incomparable alpha, and that the valuation can lag the live economics tier
// by up to ~24h because it is marked from the daily rollup.
//
// Verified against production before the switch: the live tool's response
// satisfies this schema.
export const GetAccountPortfolioOutputSchema = AccountPortfolioArtifactSchema;
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

// NOT YET DERIVED, deliberately. AccountPositionsArtifactSchema is the right
// source and this should become `= AccountPositionsArtifactSchema` -- but the
// live tool does not satisfy it today, so switching now would publish a
// contract production violates, trading one drift for another.
//
// Two things block it, both filed:
//   - the route's `degraded.reason` enum declares two values and production
//     serves a third, `positions_unpriceable` (#9804);
//   - the route requires `degraded.snapshot_captured_at` and
//     `latest_stake_event_at`, and the handler emits neither (#9803).
//
// Checked against production rather than assumed: deriving today rejects real
// responses on exactly those fields. The rename below is still fixed here,
// because that one is a plain defect with nothing blocking it.
export const GetAccountPositionsOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    ss58: z.string(),
    captured_at: z.string().nullable().optional(),
    position_count: z.int(),
    // RENAMED IN #8803, and this copy never followed (#9794). The field is
    // total_stake_alpha -- schemas-src/routes/account-positions.ts says so and
    // explains why it is alpha rather than TAO -- so this schema REQUIRED a
    // key the response has never carried since that rename. Every
    // get_account_positions response has been failing its own published
    // contract, and an agent reading the schema was told to look for a field
    // that is not there.
    total_stake_alpha: z.number(),
    positions: OpenObjectArraySchema,
    // #9273: present only when the payload's zero is not a measurement. Left
    // open here rather than typed, because the shape it should reference is the
    // one #9803/#9804 are still correcting.
    degraded: OpenObjectSchema.optional(),
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
