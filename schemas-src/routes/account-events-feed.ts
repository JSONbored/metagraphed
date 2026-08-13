// GET /api/v1/accounts/{ss58}/events + .../history + .../transfers
// (types-epic B batch 5, #8059). Live account_events/account_events_daily
// store-tier data -- no static file. Modeled from src/account-events.ts's
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
import { AccountEventSchema } from "./subnet-events.ts";

export const AccountEventsArtifactSchema = z
  .object({
    schema_version: z.int(),
    ss58: z.string(),
    event_count: z.int().min(0),
    // NULLABLE, and this is not defensive (#9796). The REST layer defaults
    // `limit`/`offset` before the loader runs, so a live route response always
    // carries integers -- which is why validate:api never saw this. The same
    // loader also serves the MCP tool, which passes the caller's arguments
    // straight through, and an omitted limit reaches it as undefined:
    // `limit: limit ?? null` then emits null. The contract said that was
    // impossible.
    limit: z.int().nullable(),
    offset: z.int().nullable(),
    next_cursor: z.string().nullable().optional(),
    events: z.array(AccountEventSchema),
  })
  .strict()
  .describe(
    "One account's first-party chain-event feed (matched by the hotkey OR coldkey union, newest first), keyset-paginated. event_count is the page count, not a grand total. Mirrors GET /api/v1/accounts/{ss58}/events' data envelope. Each item is an AccountEvent.",
  );
export type AccountEventsArtifact = z.infer<typeof AccountEventsArtifactSchema>;

const AccountDaySchema = z
  .object({
    day: z.string().nullable(),
    netuid: z.int().nullable().optional(),
    event_count: z.int().nullable().optional(),
    event_kinds: z.array(z.string()).optional(),
    first_block: z.int().nullable().optional(),
    last_block: z.int().nullable().optional(),
  })
  .strict()
  .describe(
    "One day's rolled-up activity for an account on one subnet, from the account_events_daily tier. event_kinds is the distinct set of event ids seen that day.",
  );

export const AccountHistoryArtifactSchema = z
  .object({
    schema_version: z.int(),
    ss58: z.string(),
    day_count: z.int().min(0),
    limit: z.int().nullable(),
    offset: z.int().nullable(),
    next_cursor: z.string().nullable().optional(),
    days: z.array(AccountDaySchema),
  })
  .strict()
  .describe(
    "One account's durable per-day activity series (hotkey-keyed, newest day first), keyset-paginated. day_count is the page count, not a grand total. Mirrors GET /api/v1/accounts/{ss58}/history' data envelope. Each item is an AccountDay.",
  );
export type AccountHistoryArtifact = z.infer<
  typeof AccountHistoryArtifactSchema
>;

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
  .strict()
  .describe(
    "One native-TAO Balances.Transfer event on an account's feed. direction is relative to the queried address (sent = it paid, received = it was paid).",
  );

export const AccountTransfersArtifactSchema = z
  .object({
    schema_version: z.int(),
    ss58: z.string(),
    transfer_count: z.int().min(0),
    limit: z.int().nullable(),
    offset: z.int().nullable(),
    next_cursor: z.string().nullable().optional(),
    transfers: z.array(AccountTransferEntrySchema),
  })
  .strict()
  .describe(
    "One account's native-TAO transfer feed, keyset-paginated newest-first. Mirrors GET /api/v1/accounts/{ss58}/transfers' data envelope.",
  );
export type AccountTransfersArtifact = z.infer<
  typeof AccountTransfersArtifactSchema
>;
