// MCP tool `get_account_position_history`.
// Mirrors GET /api/v1/accounts/{ss58}/subnets/{netuid}/history.
//
// DERIVED FROM THE ROUTE, NOT COPIED (#9796). Each output schema below IS the
// route's own ArtifactSchema, so a route field rename is a compile error here
// instead of silent production drift -- which is what the hand-written copies
// this replaces had already accumulated.
//
// What the copies were publishing:
//   get_account_position_history: 1 bare `{"type":"object"}` site.
//
// Verified against production before the switch, because deriving is a
// TIGHTENING -- the route schema is stricter than the copy was. Every tool in
// this file was called live and its response validated against the schema it
// now publishes.
import { z } from "zod";
import { ROUTE_QUERY_SCHEMAS } from "../route-queries.ts";
import { netuidSchema, ss58Schema } from "./shared.ts";
import { AccountPositionHistoryArtifactSchema } from "../routes/account-positions.ts";

const RouteQuery_accounts_ss58_subnets_netuid_history =
  ROUTE_QUERY_SCHEMAS["/api/v1/accounts/{ss58}/subnets/{netuid}/history"];

export const GetAccountPositionHistoryInputSchema = z
  .object({
    ss58: ss58Schema(),
    netuid: netuidSchema(),
    window: RouteQuery_accounts_ss58_subnets_netuid_history.shape.window,
  })
  .strict();
export type GetAccountPositionHistoryInput = z.infer<
  typeof GetAccountPositionHistoryInputSchema
>;

export const GetAccountPositionHistoryOutputSchema =
  AccountPositionHistoryArtifactSchema;
export type GetAccountPositionHistoryOutput = z.infer<
  typeof GetAccountPositionHistoryOutputSchema
>;
