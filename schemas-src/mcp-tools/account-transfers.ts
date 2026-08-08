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
import { COUNTERPARTIES_LIMIT_DEFAULT } from "../../src/counterparties.ts";
import { ROUTE_QUERY_SCHEMAS } from "../route-queries.ts";
import { blockBoundSchema, limitSchema, ss58Schema } from "./shared.ts";
import { AccountTransfersArtifactSchema } from "../routes/account-events-feed.ts";
import { CounterpartyRelationshipSchema } from "../routes/account-counterparties.ts";

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
    limit: RouteQuery_accounts_ss58_transfers.shape.limit.meta({
      default: 100,
    }),
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
    limit: limitSchema(100, COUNTERPARTIES_LIMIT_DEFAULT).optional(),
  })
  .strict();
export type GetAccountCounterpartiesInput = z.infer<
  typeof GetAccountCounterpartiesInputSchema
>;

// objectItems(...) properties, none required at the item level.
const CounterpartyItemSchema = z
  .object({
    address: z.string().nullable().optional(),
    sent_tao: z.unknown().optional(),
    received_tao: z.unknown().optional(),
    net_tao: z.unknown().optional(),
    transfer_count: z.int().nullable().optional(),
    last_block: z.int().nullable().optional(),
  })
  .passthrough();

export const GetAccountCounterpartiesOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    ss58: z.string(),
    counterparty_count: z.int(),
    transfers_scanned: z.int().nullable().optional(),
    scan_capped: z.boolean().optional(),
    total_sent_tao: z.unknown().optional(),
    total_received_tao: z.unknown().optional(),
    counterparties: z.array(CounterpartyItemSchema),
    // Present only in counterparty='<ss58>' drilldown mode (the per-pair
    // detail) -- bare open object, matching the hand-written original.
    // Typed from the route's own CounterpartyRelationshipSchema (#9797):
    // the fund-flow totals plus the transfer list for one drilled-into
    // counterparty. Verified against production 2026-08-07.
    relationship: CounterpartyRelationshipSchema.optional(),
  })
  .passthrough();
export type GetAccountCounterpartiesOutput = z.infer<
  typeof GetAccountCounterpartiesOutputSchema
>;
