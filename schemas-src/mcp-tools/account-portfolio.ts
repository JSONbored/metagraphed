// MCP tools `get_account_portfolio`, `get_account_positions`,
// `get_account_snapshot` (types-epic E batch 6, #8069). The first two mirror a
// GET /api/v1/accounts/{ss58}/{portfolio,positions} route; get_account_snapshot
// has no REST equivalent -- it fans out to five other tools' own live loaders
// in
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
import { AccountPositionsArtifactSchema } from "../routes/account-positions.ts";
import { AccountBalanceArtifactSchema } from "../routes/account-balance.ts";
import { AccountEventsArtifactSchema } from "../routes/account-events-feed.ts";
import { AccountSubnetsArtifactSchema } from "../routes/account-summary.ts";
import { ss58Schema } from "./shared.ts";

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

// DERIVED AT LAST (#9796). This was held back in #9794 as the one schema that
// could not switch: deriving it then would have published a contract production
// violated, because the route's `degraded.reason` enum declared two values
// while the live tool served a third, and the route required
// `degraded.snapshot_captured_at`/`latest_stake_event_at` that the forwarded
// tier omitted. #9804 fixed both at the source -- the enum is now built from
// the loader's own reason tuple, and a forwarded payload is shaped on the way
// out -- so the block is gone.
//
// Re-verified against production after that landed: the live response satisfies
// this schema on both degraded paths, which is what made it safe to switch.
//
// Deriving also finishes the #8803 rename properly. The copy REQUIRED
// `total_stake_tao`, a key the response has not carried since that rename, so
// every get_account_positions response failed its own published contract and an
// agent reading the schema was told to look for a field that is not there. And
// `positions` stops being a bare open array: the route types every position and
// says why the stake figure is alpha rather than TAO, which is exactly the trap
// a caller needs warned about.
export const GetAccountPositionsOutputSchema = AccountPositionsArtifactSchema;
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

// COMPOSED FROM THE FIVE ROUTES IT CALLS (#9797). Five bare
// `{"type":"object"}` sites stood here, on the tool whose entire purpose is
// those five views. There is no SINGLE route to derive from, but there are
// five, and the handler calls them by path -- /balance (a live RPC read,
// mirroring get_account_balance's handler exactly), /portfolio, /subnets,
// /positions and /events, each falling back to that route's own builder. The
// answer was never a fresh model; it was a composition nobody had written
// down.
//
// Verified against production before the switch, slice by slice: the live
// tool's five sections each validate against the route artifact schema they
// now publish.
export const GetAccountSnapshotOutputSchema = z
  .object({
    ss58: z.string(),
    balance: AccountBalanceArtifactSchema,
    portfolio: AccountPortfolioArtifactSchema,
    subnets: AccountSubnetsArtifactSchema,
    positions: AccountPositionsArtifactSchema,
    recent_events: AccountEventsArtifactSchema,
  })
  .strict();
export type GetAccountSnapshotOutput = z.infer<
  typeof GetAccountSnapshotOutputSchema
>;
