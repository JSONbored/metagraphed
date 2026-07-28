// GET /api/v1/subnets/{netuid}/events (types-epic B batch 1, #8055). Live
// paginated account_events feed -- no static file. AccountEventSchema is
// shared with subnet-event-summary.ts's recent_events slice (same
// src/account-events.ts formatAccountEvent() row shape). Modeled from
// formatAccountEvent()/buildSubnetEvents(), cross-checked against the
// hand-edited AccountEvent/SubnetEventsArtifact components they replace.
// AccountEvent's required set intentionally matches the hand-edited
// original (block_number + event_kind only) even though the real formatter
// always sets every key -- AccountEvent is reused by many untouched routes
// beyond this batch's two, so this batch makes no behavior change to it.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";

export const AccountEventSchema = z
  .object({
    block_number: z.int().nullable(),
    event_index: z.int().nullable().optional(),
    event_kind: z.string().nullable(),
    hotkey: z.string().nullable().optional(),
    coldkey: z.string().nullable().optional(),
    netuid: z.int().nullable().optional(),
    uid: z.int().nullable().optional(),
    amount_tao: z.number().nullable().optional(),
    alpha_amount: z.number().nullable().optional(),
    observed_at: z.iso.datetime().nullable().optional(),
    extrinsic_index: z.int().nullable().optional(),
    // #8369: what this trade was worth, at this trade. Additive + optional,
    // so every existing consumer is unaffected.
    //
    // TAO per alpha, computed from the two legs already on the row
    // (amount_tao / alpha_amount) -- the SAME per-trade price the OHLC
    // endpoint aggregates into candles, so this is the exact execution
    // price, not a bucket average. Null whenever it isn't derivable: a
    // non-swap event (transfer, registration), the root subnet, or a
    // malformed leg. Deliberately TAO-denominated only -- see
    // src/price-at-tx.ts on why there is no USD companion field.
    price_at_tx: z.number().nullable().optional(),
    // How the price was arrived at, so precision is never guessed at:
    // "trade_exact" = this trade's own two legs; "root_no_pool" = root
    // (netuid 0) has no AMM, so no price exists rather than one being
    // unknown.
    price_basis: z.enum(["trade_exact", "root_no_pool"]).nullable().optional(),
  })
  .strict();
export type AccountEvent = z.infer<typeof AccountEventSchema>;

export const SubnetEventsArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int(),
    event_count: z.int().min(0),
    limit: z.int().optional(),
    offset: z.int().optional(),
    next_cursor: z.string().nullable().optional(),
    events: z.array(AccountEventSchema),
  })
  .passthrough();
export type SubnetEventsArtifact = z.infer<typeof SubnetEventsArtifactSchema>;
export const SubnetEventsResponseSchema = successEnvelopeSchema(
  SubnetEventsArtifactSchema,
);

export const SubnetEventsQuerySchema = z
  .object({
    kind: z.string().optional(),
    block_start: z.int().min(0).optional(),
    block_end: z.int().min(0).optional(),
    limit: z.int().min(1).max(1000).optional(),
    offset: z.int().min(0).optional(),
    format: z.enum(["json", "csv"]).optional(),
  })
  .strict();
export type SubnetEventsQuery = z.infer<typeof SubnetEventsQuerySchema>;
