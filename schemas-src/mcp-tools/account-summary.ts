// MCP tools `get_account_entities`, `get_account_events`.
// Mirror GET /api/v1/accounts/{ss58}/entities, GET
// /api/v1/accounts/{ss58}/events.
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
import {
  AccountSubnetsArtifactSchema,
  AccountSummaryArtifactSchema,
} from "../routes/account-summary.ts";
import { ROUTE_QUERY_SCHEMAS } from "../route-queries.ts";
import { blockBoundSchema, ss58Schema } from "./shared.ts";
import { AccountEntitiesArtifactSchema } from "../routes/account-entities.ts";
import { AccountEventsArtifactSchema } from "../routes/account-events-feed.ts";

const RouteQuery_accounts_ss58_events =
  ROUTE_QUERY_SCHEMAS["/api/v1/accounts/{ss58}/events"];

export const GetAccountInputSchema = z
  .object({
    ss58: ss58Schema(),
  })
  .strict();
export type GetAccountInput = z.infer<typeof GetAccountInputSchema>;

// THE ROUTE'S OWN SCHEMA (#10790). The copy this replaces restated all
// fourteen fields and drifted on seven of them: `z.int()` where the route
// bounds at zero, an inline `event_kinds` beside the route's own
// `AccountEventKindCount`, and three local item schemas -- label, registration,
// event -- each a second opinion about a shape the route already owns. This
// tool serves the route's payload unchanged, so no delta survives.
export const GetAccountOutputSchema = AccountSummaryArtifactSchema;
export type GetAccountOutput = z.infer<typeof GetAccountOutputSchema>;

export const GetAccountEntitiesInputSchema = z
  .object({
    ss58: ss58Schema(),
  })
  .strict();
export type GetAccountEntitiesInput = z.infer<
  typeof GetAccountEntitiesInputSchema
>;

export const GetAccountEntitiesOutputSchema = AccountEntitiesArtifactSchema;
export type GetAccountEntitiesOutput = z.infer<
  typeof GetAccountEntitiesOutputSchema
>;

export const GetAccountEventsInputSchema = z
  .object({
    ss58: ss58Schema(),
    kind: RouteQuery_accounts_ss58_events.shape.kind,
    netuid: RouteQuery_accounts_ss58_events.shape.netuid,
    block_start: blockBoundSchema("first").optional(),
    block_end: blockBoundSchema("last").optional(),
    limit: RouteQuery_accounts_ss58_events.shape.limit,
    offset: RouteQuery_accounts_ss58_events.shape.offset,
    cursor: RouteQuery_accounts_ss58_events.shape.cursor,
  })
  .strict();
export type GetAccountEventsInput = z.infer<typeof GetAccountEventsInputSchema>;

export const GetAccountEventsOutputSchema = AccountEventsArtifactSchema;
export type GetAccountEventsOutput = z.infer<
  typeof GetAccountEventsOutputSchema
>;

export const GetAccountSubnetsInputSchema = z
  .object({
    ss58: ss58Schema(),
  })
  .strict();
export type GetAccountSubnetsInput = z.infer<
  typeof GetAccountSubnetsInputSchema
>;

export const GetAccountSubnetsOutputSchema = AccountSubnetsArtifactSchema;
export type GetAccountSubnetsOutput = z.infer<
  typeof GetAccountSubnetsOutputSchema
>;
