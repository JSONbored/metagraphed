// MCP tools `list_accounts`, `get_top_holders`.
// Mirror GET /api/v1/accounts, GET /api/v1/accounts/top-holders.
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
import { limitSchema, sortSchema } from "./shared.ts";
import { AccountsListArtifactSchema } from "../routes/accounts-list.ts";
import { TopHoldersArtifactSchema } from "../routes/top-holders.ts";

// Symbolic in the hand-written originals (src/accounts-list.ts's
// ACCOUNTS_LIST_SORTS/*_LIMIT_*, src/top-holders.ts's TOP_HOLDERS_SORTS/
// *_LIMIT_*), cross-checked against the actual runtime source at the time
// of writing.
const ACCOUNTS_LIST_SORTS = [
  "total_stake",
  "total_emission",
  "subnet_count",
  "uid_count",
  "validator_count",
  "stake_dominance",
  "last_active",
] as const;
const TOP_HOLDERS_SORTS = [
  "total_tao",
  "free_tao",
  "delegated_tao",
  "net_flow_7d",
  "net_flow_30d",
  "net_flow_90d",
] as const;

export const ListAccountsInputSchema = z
  .object({
    sort: sortSchema(ACCOUNTS_LIST_SORTS).optional(),
    limit: limitSchema(100).optional(),
  })
  .strict();
export type ListAccountsInput = z.infer<typeof ListAccountsInputSchema>;

// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note from the pilot batch).
export const ListAccountsOutputSchema = AccountsListArtifactSchema;
export type ListAccountsOutput = z.infer<typeof ListAccountsOutputSchema>;

export const GetTopHoldersInputSchema = z
  .object({
    sort: sortSchema(TOP_HOLDERS_SORTS).optional(),
    limit: limitSchema(100).optional(),
  })
  .strict();
export type GetTopHoldersInput = z.infer<typeof GetTopHoldersInputSchema>;

// objectItems(...) properties, none required at the item level.
export const GetTopHoldersOutputSchema = TopHoldersArtifactSchema;
export type GetTopHoldersOutput = z.infer<typeof GetTopHoldersOutputSchema>;
