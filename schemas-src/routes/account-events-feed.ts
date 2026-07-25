// GET /api/v1/accounts/{ss58}/events + .../history + .../transfers
// (types-epic B batch 5, #8059). Live account_events/account_events_daily
// D1-tier data -- no static file. Modeled from src/account-events.ts's
// buildAccountEvents()/buildAccountHistory()/formatAccountDay()/
// buildAccountTransfers(), cross-checked against the hand-edited
// AccountEventsArtifact/AccountHistoryArtifact/AccountTransfersArtifact
// components they replace.
//
// AccountEventSchema is REUSED from subnet-events.ts (types-epic B batch 1,
// #8055) rather than redefined -- AccountEventsArtifact.events[] is the same
// shape. AccountDay is intentionally NOT registered as a shared component --
// AccountHistoryArtifact is its only referrer anywhere in schemas/
// components/*.schema.json (verified via repo-wide $ref grep), so the
// hand-edited component key becomes fully orphaned.
//
// Real finding (bucket a): `limit`/`offset` were initially modeled
// `.nullable()` (matching each builder's own `limit ?? null` TS signature),
// but every one of these 3 routes' handlers resolves them via
// workers/request-params.ts's parsePagination(), which always returns real
// numbers (`{limit: number, offset: number}`, confirmed by its own return
// type) -- the builders' null fallback only matters for a direct/internal
// caller that omits them, never the real HTTP-served output. Fixed to
// required non-nullable integers, matching the hand-edited components and
// what the route actually returns.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";
import { AccountEventSchema } from "./subnet-events.ts";

export const AccountEventsArtifactSchema = z
  .object({
    schema_version: z.int(),
    ss58: z.string(),
    event_count: z.int().min(0),
    limit: z.int(),
    offset: z.int(),
    next_cursor: z.string().nullable().optional(),
    events: z.array(AccountEventSchema),
  })
  .passthrough();
export type AccountEventsArtifact = z.infer<typeof AccountEventsArtifactSchema>;
export const AccountEventsResponseSchema = successEnvelopeSchema(
  AccountEventsArtifactSchema,
);
export const AccountEventsQuerySchema = z
  .object({
    kind: z.string().optional(),
    netuid: z.int().min(0).optional(),
    block_start: z.int().min(0).optional(),
    block_end: z.int().min(0).optional(),
    limit: z.int().min(1).max(1000).optional(),
    offset: z.int().min(0).optional(),
    cursor: z.string().optional(),
    format: z.enum(["json", "csv"]).optional(),
  })
  .strict();
export type AccountEventsQuery = z.infer<typeof AccountEventsQuerySchema>;

const AccountDaySchema = z
  .object({
    day: z.string().nullable(),
    netuid: z.int().nullable().optional(),
    event_count: z.int().nullable().optional(),
    event_kinds: z.array(z.string()).optional(),
    first_block: z.int().nullable().optional(),
    last_block: z.int().nullable().optional(),
  })
  .passthrough();

export const AccountHistoryArtifactSchema = z
  .object({
    schema_version: z.int(),
    ss58: z.string(),
    day_count: z.int().min(0),
    limit: z.int(),
    offset: z.int(),
    next_cursor: z.string().nullable().optional(),
    days: z.array(AccountDaySchema),
  })
  .passthrough();
export type AccountHistoryArtifact = z.infer<
  typeof AccountHistoryArtifactSchema
>;
export const AccountHistoryResponseSchema = successEnvelopeSchema(
  AccountHistoryArtifactSchema,
);
export const AccountHistoryQuerySchema = z
  .object({
    netuid: z.int().min(0).optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    limit: z.int().min(1).optional(),
    offset: z.int().min(0).optional(),
  })
  .strict();
export type AccountHistoryQuery = z.infer<typeof AccountHistoryQuerySchema>;

const AccountTransferEntrySchema = z
  .object({
    block_number: z.int().nullable(),
    event_index: z.int().nullable().optional(),
    from: z.string().nullable(),
    to: z.string().nullable(),
    amount_tao: z.number().nullable().optional(),
    direction: z.enum(["sent", "received"]).nullable().optional(),
    observed_at: z.string().nullable().optional(),
  })
  .strict();

export const AccountTransfersArtifactSchema = z
  .object({
    schema_version: z.int(),
    ss58: z.string(),
    transfer_count: z.int().min(0),
    limit: z.int(),
    offset: z.int(),
    next_cursor: z.string().nullable().optional(),
    transfers: z.array(AccountTransferEntrySchema),
  })
  .passthrough();
export type AccountTransfersArtifact = z.infer<
  typeof AccountTransfersArtifactSchema
>;
export const AccountTransfersResponseSchema = successEnvelopeSchema(
  AccountTransfersArtifactSchema,
);
export const AccountTransfersQuerySchema = z
  .object({
    direction: z.enum(["all", "sent", "received"]).optional(),
    block_start: z.int().min(0).optional(),
    block_end: z.int().min(0).optional(),
    limit: z.int().min(1).optional(),
    offset: z.int().min(0).optional(),
    cursor: z.string().optional(),
    format: z.enum(["json", "csv"]).optional(),
  })
  .strict();
export type AccountTransfersQuery = z.infer<typeof AccountTransfersQuerySchema>;
