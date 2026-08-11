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
import { ROUTE_QUERY_SCHEMAS } from "../route-queries.ts";
import { blockBoundSchema, netuidSchema, ss58Schema } from "./shared.ts";
import { AccountEntitiesArtifactSchema } from "../routes/account-entities.ts";
import { AccountEventsArtifactSchema } from "../routes/account-events-feed.ts";
import { AccountActivitySchema } from "../routes/account-summary.ts";

// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note from the pilot batch).
const AccountEventItemSchema = z
  .object({
    block_number: z.int().nullable().optional(),
    event_index: z.int().nullable().optional(),
    event_kind: z.string().nullable().optional(),
    hotkey: z.string().nullable().optional(),
    coldkey: z.string().nullable().optional(),
    netuid: netuidSchema().nullable().optional(),
    uid: z.int().nullable().optional(),
    amount_tao: z.unknown().optional(),
    alpha_amount: z.unknown().optional(),
    observed_at: z.string().nullable().optional(),
    extrinsic_index: z.int().nullable().optional(),
  })
  .strict();

const AccountRegistrationItemSchema = z
  .object({
    netuid: netuidSchema().nullable().optional(),
    uid: z.int().nullable().optional(),
    stake_tao: z.unknown().optional(),
    validator_permit: z.boolean().optional(),
    active: z.boolean().optional(),
  })
  .strict();

const AccountLabelItemSchema = z
  .object({
    name: z.string().nullable().optional(),
    category: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    source_urls: z.array(z.string()).optional(),
  })
  .strict();

const RouteQuery_accounts_ss58_events =
  ROUTE_QUERY_SCHEMAS["/api/v1/accounts/{ss58}/events"];

export const GetAccountInputSchema = z
  .object({
    ss58: ss58Schema(),
  })
  .strict();
export type GetAccountInput = z.infer<typeof GetAccountInputSchema>;

export const GetAccountOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    ss58: z.string(),
    event_count: z.int(),
    subnet_count: z.int(),
    // Whether the scan behind `event_count` hit its ceiling, undeclared until
    // #10790. True means the count is a FLOOR, not a total -- exactly the
    // caveat that stops a number being read as a measurement.
    event_scan_capped: z.boolean().optional(),
    first_block: z.int().nullable().optional(),
    last_block: z.int().nullable().optional(),
    first_seen_at: z.string().nullable().optional(),
    last_seen_at: z.string().nullable().optional(),
    event_kinds: z.array(
      z
        .object({
          kind: z.string().optional(),
          count: z.int().optional(),
        })
        .strict(),
    ),
    registrations: z.array(AccountRegistrationItemSchema),
    recent_events: z.array(AccountEventItemSchema),
    // Typed from the route's own AccountActivitySchema (#9797) -- the
    // per-kind event breakdown and first/last block/timestamp seen. This tool
    // advertises no `fields`, so it is not partial. Verified against
    // production 2026-08-07.
    activity: AccountActivitySchema.optional(),
    labels: z.array(AccountLabelItemSchema).optional(),
  })
  .strict();
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

export const GetAccountSubnetsOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    ss58: z.string(),
    subnet_count: z.int(),
    subnets: z.array(AccountRegistrationItemSchema),
  })
  .strict();
export type GetAccountSubnetsOutput = z.infer<
  typeof GetAccountSubnetsOutputSchema
>;
