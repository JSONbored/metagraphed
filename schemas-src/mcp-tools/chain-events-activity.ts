// MCP tools `get_chain_activity`, `list_chain_events`, `get_network_activity`.
// Mirror GET /api/v1/chain-events/stats, GET /api/v1/chain-events, GET
// /api/v1/chain/activity.
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
import { CHAIN_EVENTS_LIMIT_DEFAULT } from "../../src/route-limits.ts";
import { ROUTE_QUERY_SCHEMAS } from "../route-queries.ts";
import { keysetCursorSchema, limitSchema } from "./shared.ts";
import { McpNetworkSchema } from "../shared.ts";
import { ChainActivityArtifactSchema } from "../routes/chain-analytics.ts";
import {
  ChainEventsFeedArtifactSchema,
  ChainEventsStatsArtifactSchema,
} from "../routes/chain-events.ts";

/** The ceiling /chain-events enforces on `pallet` and `method` --
 * validateListQuery reads it off the PUBLISHED schema to decide a 400. */

const RouteQuery_chain_activity = ROUTE_QUERY_SCHEMAS["/api/v1/chain/activity"];

const RouteQuery_chain_events_stats =
  ROUTE_QUERY_SCHEMAS["/api/v1/chain-events/stats"];

const RouteQuery_chain_events = ROUTE_QUERY_SCHEMAS["/api/v1/chain-events"];

export const GetChainActivityInputSchema = z
  .object({
    blocks: RouteQuery_chain_events_stats.shape.blocks
      .describe("How many trailing blocks to cover, ending at the chain head.")
      .meta({ examples: [1200] }),
    // #8700: which chain's decoded history to aggregate. The same published
    // finney/test enum every network-aware tool takes, so one vocabulary
    // covers the whole surface.
    network: McpNetworkSchema.optional(),
  })
  .strict();
export type GetChainActivityInput = z.infer<typeof GetChainActivityInputSchema>;

// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note from the pilot batch).
export const GetChainActivityOutputSchema = ChainEventsStatsArtifactSchema;
export type GetChainActivityOutput = z.infer<
  typeof GetChainActivityOutputSchema
>;

export const ListChainEventsInputSchema = z
  .object({
    pallet: RouteQuery_chain_events.shape.pallet
      .describe(
        "Restrict to events emitted by this pallet, by runtime name (`SubtensorModule`). Case-sensitive.",
      )
      .meta({ examples: ["SubtensorModule"] }),
    // NOT an HTTP method. This said "HTTP method to use for the call" beside
    // an example of `set_weights` -- the prose contradicted its own example,
    // on a parameter whose whole job is naming a runtime call (#10131).
    method: RouteQuery_chain_events.shape.method
      .describe(
        "Restrict to events emitted by this runtime call, by name (`set_weights`). Case-sensitive.",
      )
      .meta({ examples: ["set_weights"] }),
    block: z
      .int()
      .min(0)
      .optional()
      .describe("Restrict to this exact block height.")
      .meta({ examples: [8783000] }),
    extrinsic: z
      .int()
      .min(0)
      .optional()
      .describe(
        "Restrict to one extrinsic's events by its index within the block. Requires `block`.",
      )
      .meta({ examples: [14] }),
    // `block_number.event_index`, not an opaque token -- the route publishes
    // and enforces that shape, so a bare string advertised a value it rejects
    // (#10118). keysetCursorSchema() stays for the genuinely opaque base64
    // cursors, which have nothing to bound.
    // Opaque, matching the route it mirrors. It published a two-part
    // `block.index` shape for a feed whose cursor has three parts (#10316).
    cursor: keysetCursorSchema().optional(),
    before: z
      .int()
      .min(0)
      .optional()
      .describe(
        "Legacy cursor: return rows strictly BEFORE this block height. Prefer `cursor` where a tool offers one.",
      )
      .meta({ examples: [8783000] }),
    limit: limitSchema(200, CHAIN_EVENTS_LIMIT_DEFAULT).optional(),
    network: McpNetworkSchema.optional(),
  })
  .strict();
export type ListChainEventsInput = z.infer<typeof ListChainEventsInputSchema>;

// objectItems(...) properties, none required at the item level. observed_at
// is a fully untyped ANY here in the hand-written original -- NOT the
// nullable-integer CHAIN_EVENT_ITEM convention batch 8's
// get_block_chain_events/get_extrinsic_chain_events use for the same field
// name; this tool inlines its own item shape rather than sharing that one.
export const ListChainEventsOutputSchema = ChainEventsFeedArtifactSchema;
export type ListChainEventsOutput = z.infer<typeof ListChainEventsOutputSchema>;

export const GetNetworkActivityInputSchema = z
  .object({
    window: RouteQuery_chain_activity.shape.window,
  })
  .strict();
export type GetNetworkActivityInput = z.infer<
  typeof GetNetworkActivityInputSchema
>;

// objectItems(...) properties, none required at the item level.
export const GetNetworkActivityOutputSchema = ChainActivityArtifactSchema;
export type GetNetworkActivityOutput = z.infer<
  typeof GetNetworkActivityOutputSchema
>;
