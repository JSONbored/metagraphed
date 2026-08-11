// MCP tools `get_block_chain_events`, `get_extrinsic_chain_events`
// (types-epic E batch 8, #8071). Each mirrors a GET /api/v1/{blocks/*/chain-
// events,chain-events} route that is not one of schemas-src/routes/'s
// covered pilot routes -- no existing Zod schema to reuse. Modeled fresh,
// matching each hand-written literal field-for-field.
import { z } from "zod";
import { CHAIN_EVENTS_LIMIT_DEFAULT } from "../../src/route-limits.ts";
import { ROUTE_QUERY_SCHEMAS } from "../route-queries.ts";
import { keysetCursorSchema, limitSchema } from "./shared.ts";
import { McpNetworkSchema } from "../shared.ts";

const RouteQuery_chain_events = ROUTE_QUERY_SCHEMAS["/api/v1/chain-events"];

export const GetBlockChainEventsInputSchema = z
  .object({
    block_number: z
      .int()
      .min(0)
      .describe("The block height to read.")
      .meta({ examples: [8783000] }),
    // #8700: which chain's history to read. The same published finney/test
    // enum every network-aware tool takes.
    network: McpNetworkSchema.optional(),
  })
  .strict();
export type GetBlockChainEventsInput = z.infer<
  typeof GetBlockChainEventsInputSchema
>;

// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note from the pilot batch). observed_at here is
// a plain nullable INTEGER (epoch ms), unlike the nullable STRING timestamp
// convention every other item shape in this epic uses -- the hand-written
// original's CHAIN_EVENT_ITEM literally wraps it in NULLABLE_INT, not
// NULLABLE_STRING.
const ChainEventItemSchema = z
  .object({
    block_number: z.int().nullable().optional(),
    event_index: z.int().nullable().optional(),
    pallet: z.string().nullable().optional(),
    method: z.string().nullable().optional(),
    args: z.unknown().optional(),
    phase: z.unknown().optional(),
    extrinsic_index: z.int().nullable().optional(),
    observed_at: z.int().nullable().optional(),
    // #8525: deterministic human-readable action sentence for this event's
    // pallet.method, or null when no template matches -- never a
    // guessed/partial sentence.
    summary: z.string().nullable().optional(),
  })
  .strict();

export const GetBlockChainEventsOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    block_number: z.int().nullable(),
    event_count: z.int(),
    events: z.array(ChainEventItemSchema),
  })
  .strict();
export type GetBlockChainEventsOutput = z.infer<
  typeof GetBlockChainEventsOutputSchema
>;

export const GetExtrinsicChainEventsInputSchema = z
  .object({
    // This is an EXTRINSIC reference, not a block one (#9795). The description
    // here was the sibling block tools' -- "a block NUMBER or a 0x-prefixed
    // block HASH" -- and both examples followed it, so every agent that read
    // the contract and copied the example got `invalid_params`. Verified
    // against production: `8791987` and a full block hash are both rejected,
    // and only the composite form is accepted.
    ref: z
      .string()
      .regex(/^\d+-\d+$/)
      .describe(
        "Extrinsic reference, as the composite id `block_number-extrinsic_index` -- the index is the extrinsic's position within that block, from 0. A bare block number or block hash is NOT accepted here, unlike the sibling block-scoped tools.",
      )
      .meta({ examples: ["8791987-0"] }),
    // The two filters an extrinsic's OWN event list can still take (#10793).
    // One extrinsic emits many events, often across several pallets -- a
    // `add_stake` carries Balances, SubtensorModule and System events together
    // -- so "which Balances events did this extrinsic emit" is a real question
    // that cost a full page and a client-side scan before.
    //
    // Straight off the route's query schema, the same way list_chain_events
    // takes them, so the three surfaces cannot disagree about the length bound
    // or the case sensitivity.
    pallet: RouteQuery_chain_events.shape.pallet
      .describe(
        "Restrict to events emitted by this pallet, by runtime name (`SubtensorModule`). Case-sensitive. Applied within this extrinsic's events, not across the feed.",
      )
      .meta({ examples: ["SubtensorModule"] }),
    method: RouteQuery_chain_events.shape.method
      .describe(
        "Restrict to events emitted by this runtime call, by name (`set_weights`). Case-sensitive. Applied within this extrinsic's events, not across the feed.",
      )
      .meta({ examples: ["set_weights"] }),
    limit: limitSchema(200, CHAIN_EVENTS_LIMIT_DEFAULT).optional(),
    // `block_number.event_index`, not an opaque token -- the route publishes
    // and enforces that shape, so a bare string advertised a value it rejects
    // (#10118). keysetCursorSchema() stays for the genuinely opaque base64
    // cursors, which have nothing to bound.
    // Opaque, matching the route it mirrors. It published a two-part
    // `block.index` shape for a feed whose cursor has three parts (#10316).
    cursor: keysetCursorSchema().optional(),
    network: McpNetworkSchema.optional(),
  })
  .strict();
export type GetExtrinsicChainEventsInput = z.infer<
  typeof GetExtrinsicChainEventsInputSchema
>;

export const GetExtrinsicChainEventsOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    ref: z.unknown(),
    block_number: z.int().nullable(),
    extrinsic_index: z.int().nullable(),
    limit: z.int().nullable().optional(),
    event_count: z.int(),
    next_cursor: z.string().nullable().optional(),
    events: z.array(ChainEventItemSchema),
  })
  .strict();
export type GetExtrinsicChainEventsOutput = z.infer<
  typeof GetExtrinsicChainEventsOutputSchema
>;
