// MCP tool `get_account_transfers`.
// Mirrors GET /api/v1/accounts/{ss58}/transfers.
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
import { blockBoundSchema, ss58Schema } from "./shared.ts";
import { AccountTransfersArtifactSchema } from "../routes/account-events-feed.ts";
import { AccountCounterpartiesArtifactSchema } from "../routes/account-counterparties.ts";

const RouteQuery_accounts_ss58_transfers =
  ROUTE_QUERY_SCHEMAS["/api/v1/accounts/{ss58}/transfers"];

const RouteQuery_accounts_ss58_counterparties =
  ROUTE_QUERY_SCHEMAS["/api/v1/accounts/{ss58}/counterparties"];

export const GetAccountTransfersInputSchema = z
  .object({
    ss58: ss58Schema(),
    direction: RouteQuery_accounts_ss58_transfers.shape.direction
      .describe(
        "Which side of the flow to include: everything, only outgoing, or only incoming.",
      )
      .meta({ examples: ["all"] }),
    block_start: blockBoundSchema("first").optional(),
    block_end: blockBoundSchema("last").optional(),
    limit: RouteQuery_accounts_ss58_transfers.shape.limit,
    offset: RouteQuery_accounts_ss58_transfers.shape.offset,
    cursor: RouteQuery_accounts_ss58_transfers.shape.cursor,
  })
  .strict();
export type GetAccountTransfersInput = z.infer<
  typeof GetAccountTransfersInputSchema
>;

// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note from the pilot batch).
export const GetAccountTransfersOutputSchema = AccountTransfersArtifactSchema;
export type GetAccountTransfersOutput = z.infer<
  typeof GetAccountTransfersOutputSchema
>;

export const GetAccountCounterpartiesInputSchema = z
  .object({
    ss58: ss58Schema(),
    counterparty: RouteQuery_accounts_ss58_counterparties.shape.counterparty
      .describe(
        "The other SS58 account in the transfer pair — results are restricted to flows between the subject account and this one.",
      )
      .meta({ examples: ["5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F"] }),
    // Inherited rather than restated: the route publishes the same ceiling and
    // the same default now that both are named in src/counterparties.ts, so a
    // local `limitSchema(100, …)` would be a second copy of a bound the route
    // already declares.
    limit: RouteQuery_accounts_ss58_counterparties.shape.limit,
  })
  .strict();
export type GetAccountCounterpartiesInput = z.infer<
  typeof GetAccountCounterpartiesInputSchema
>;

// THE ROUTE'S OWN SCHEMA (#10790). The copy typed four TAO totals as
// `z.unknown()` -- which describes nothing at all -- and made `scan_capped`
// optional, the one field that says whether `counterparty_count` is a total or
// a floor.
export const GetAccountCounterpartiesOutputSchema =
  AccountCounterpartiesArtifactSchema;
export type GetAccountCounterpartiesOutput = z.infer<
  typeof GetAccountCounterpartiesOutputSchema
>;
