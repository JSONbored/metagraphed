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
import { ROUTE_QUERY_SCHEMAS } from "../route-queries.ts";
import { AccountsListArtifactSchema } from "../routes/accounts-list.ts";
import { TopHoldersArtifactSchema } from "../routes/top-holders.ts";

// Symbolic in the hand-written originals (src/accounts-list.ts's
// ACCOUNTS_LIST_LIST_SORTS_VALUES/*_LIMIT_*, src/top-holders.ts's TOP_HOLDERS_SORT_VALUES/
// *_LIMIT_*), cross-checked against the actual runtime source at the time
// of writing.
const RouteQuery_accounts = ROUTE_QUERY_SCHEMAS["/api/v1/accounts"];

const RouteQuery_accounts_top_holders =
  ROUTE_QUERY_SCHEMAS["/api/v1/accounts/top-holders"];

export const ListAccountsInputSchema = z
  .object({
    sort: RouteQuery_accounts.shape.sort,
    limit: RouteQuery_accounts.shape.limit,
  })
  .strict();
export type ListAccountsInput = z.infer<typeof ListAccountsInputSchema>;

// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note from the pilot batch).
export const ListAccountsOutputSchema = AccountsListArtifactSchema;
export type ListAccountsOutput = z.infer<typeof ListAccountsOutputSchema>;

export const GetTopHoldersInputSchema = z
  .object({
    sort: RouteQuery_accounts_top_holders.shape.sort,
    limit: RouteQuery_accounts_top_holders.shape.limit,
  })
  .strict();
export type GetTopHoldersInput = z.infer<typeof GetTopHoldersInputSchema>;

// objectItems(...) properties, none required at the item level.
export const GetTopHoldersOutputSchema = TopHoldersArtifactSchema;
export type GetTopHoldersOutput = z.infer<typeof GetTopHoldersOutputSchema>;
