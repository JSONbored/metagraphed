// MCP tool `get_account_stake_flow`.
// Mirrors GET /api/v1/accounts/{ss58}/stake-flow.
//
// DERIVED FROM THE ROUTE, NOT COPIED (#9796). Each output schema below IS the
// route's own ArtifactSchema, so a route field rename is a compile error here
// instead of silent production drift -- which is what the hand-written copies
// this replaces had already accumulated.
//
// Verified against production before the switch, because deriving is a
// TIGHTENING -- the route schema is stricter than the copy was. Every tool in
// this file was called live and its response validated against the schema it
// now publishes.
import { z } from "zod";
import { kindSchema, ss58Schema, windowSchema } from "./shared.ts";
import { AccountStakeFlowArtifactSchema } from "../routes/account-activity.ts";

// Symbolic in the hand-written original (src/stake-flow.ts's
// STAKE_FLOW_WINDOWS/STAKE_FLOW_DIRECTIONS), cross-checked against the
// actual runtime source at the time of writing.
const ACCOUNT_STAKE_FLOW_WINDOWS = ["7d", "30d", "90d"] as const;
const ACCOUNT_STAKE_FLOW_DIRECTIONS = ["all", "in", "out"] as const;

export const GetAccountStakeFlowInputSchema = z
  .object({
    ss58: ss58Schema(),
    window: windowSchema(ACCOUNT_STAKE_FLOW_WINDOWS).optional(),
    direction: kindSchema(ACCOUNT_STAKE_FLOW_DIRECTIONS).optional(),
  })
  .strict();
export type GetAccountStakeFlowInput = z.infer<
  typeof GetAccountStakeFlowInputSchema
>;

// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note from the pilot batch).
export const GetAccountStakeFlowOutputSchema = AccountStakeFlowArtifactSchema;
export type GetAccountStakeFlowOutput = z.infer<
  typeof GetAccountStakeFlowOutputSchema
>;
