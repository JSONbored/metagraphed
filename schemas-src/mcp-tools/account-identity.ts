// MCP tools `get_account_identity`, `get_account_identity_history`.
// Mirror GET /api/v1/accounts/{ss58}/identity, GET
// /api/v1/accounts/{ss58}/identity-history.
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
import { ss58Schema } from "./shared.ts";
import {
  AccountIdentityArtifactSchema,
  AccountIdentityHistoryArtifactSchema,
} from "../routes/account-identity.ts";

const RouteQuery_accounts_ss58_identity_history =
  ROUTE_QUERY_SCHEMAS["/api/v1/accounts/{ss58}/identity-history"];

export const GetAccountIdentityInputSchema = z
  .object({
    ss58: ss58Schema(),
  })
  .strict();
export type GetAccountIdentityInput = z.infer<
  typeof GetAccountIdentityInputSchema
>;

export const GetAccountIdentityOutputSchema = AccountIdentityArtifactSchema;
export type GetAccountIdentityOutput = z.infer<
  typeof GetAccountIdentityOutputSchema
>;

export const GetAccountIdentityHistoryInputSchema = z
  .object({
    ss58: ss58Schema(),
    limit: RouteQuery_accounts_ss58_identity_history.shape.limit,
    offset: RouteQuery_accounts_ss58_identity_history.shape.offset,
    cursor: RouteQuery_accounts_ss58_identity_history.shape.cursor,
  })
  .strict();
export type GetAccountIdentityHistoryInput = z.infer<
  typeof GetAccountIdentityHistoryInputSchema
>;

// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note from the pilot batch) -- except
// identity_hash, which is a real finding (bucket b), same root cause
// #8055/#8067 already found and fixed for the subnet-scoped identity
// history: formatAccountIdentityHistoryEntry() (src/account-identity-
// history.ts) unconditionally sets `entry.identity_hash = row.identity_hash
// ?? null`, so the key itself is always present even though the hand-
// written original never required it. Modeled here as nullable (still
// required), matching real behavior.
export const GetAccountIdentityHistoryOutputSchema =
  AccountIdentityHistoryArtifactSchema;
export type GetAccountIdentityHistoryOutput = z.infer<
  typeof GetAccountIdentityHistoryOutputSchema
>;
