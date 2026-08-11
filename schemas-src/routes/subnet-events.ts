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
    // malformed leg.
    price_at_tx: z.number().nullable().optional(),
    // How the price was arrived at, so precision is never guessed at:
    // "trade_exact" = this trade's own two legs; "root_no_pool" = root
    // (netuid 0) has no AMM, so no price exists rather than one being
    // unknown.
    price_basis: z.enum(["trade_exact", "root_no_pool"]).nullable().optional(),
    // The FIAT companion (#8602). USD per alpha at this trade: price_at_tx
    // multiplied by the newest tao_usd_index reading at-or-before this event's
    // own instant. NULL for any event predating the index -- it starts when we
    // started collecting, and carrying the oldest rate backwards would be
    // fabrication rather than data.
    usd_at_tx: z.number().nullable().optional(),
    // A DIFFERENT KIND OF CLAIM from price_basis, which is why it is a
    // separate field: "trade_exact" means the alpha price came from this row's
    // own two legs and is exact, while "index_at_or_before" means the dollar
    // leg is a lookup. A consumer must be able to tell them apart rather than
    // reading one confidence off the other.
    usd_basis: z.enum(["index_at_or_before"]).nullable().optional(),
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
  .strict()
  .describe(
    "One subnet's paginated first-party chain-event feed (#7172), newest first, offset-paginated. event_count is the page count, not a grand total. Each item is an AccountEvent. Empty feed on a cold/absent store. Mirrors GET /api/v1/subnets/{netuid}/events' data envelope.",
  );
export type SubnetEventsArtifact = z.infer<typeof SubnetEventsArtifactSchema>;
