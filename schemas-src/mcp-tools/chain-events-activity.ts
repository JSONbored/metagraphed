// MCP tools `get_chain_activity`, `list_chain_events`, `get_network_activity`
// (types-epic E batch 9, #8072). Each mirrors a GET /api/v1/chain{-events,
// /activity} route that is not one of schemas-src/routes/'s covered pilot
// routes -- no existing Zod schema to reuse. Modeled fresh, matching each
// hand-written literal field-for-field. `window` on all three tools using it
// is a LITERAL inline `["7d","30d"]` enum in the hand-written original (no
// symbolic *_WINDOWS import, unlike chain-leaderboards.ts's tools), backed by
// the shared parseAnalyticsWindow() runtime helper rather than an
// Object.hasOwn() check -- modeled the same way here, no shared constant.
import { z } from "zod";
import { McpNetworkSchema } from "../shared.ts";

const WINDOWS_2 = ["7d", "30d"] as const;

export const GetChainActivityInputSchema = z
  .object({
    blocks: z.int().min(1).max(5000).optional(),
    // #8700: which chain's decoded history to aggregate. The same published
    // finney/test enum every network-aware tool takes, so one vocabulary
    // covers the whole surface.
    network: McpNetworkSchema.optional(),
  })
  .strict();
export type GetChainActivityInput = z.infer<typeof GetChainActivityInputSchema>;

// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note from the pilot batch).
const ChainActivityGroupSchema = z
  .object({
    pallet: z.string().nullable().optional(),
    method: z.string().nullable().optional(),
    count: z.int().nullable().optional(),
  })
  .passthrough();

export const GetChainActivityOutputSchema = z
  .object({
    window_blocks: z.int(),
    groups: z.int(),
    activity: z.array(ChainActivityGroupSchema),
  })
  .passthrough();
export type GetChainActivityOutput = z.infer<
  typeof GetChainActivityOutputSchema
>;

export const ListChainEventsInputSchema = z
  .object({
    pallet: z.string().optional(),
    method: z.string().optional(),
    block: z.int().min(0).optional(),
    extrinsic: z.int().min(0).optional(),
    cursor: z.string().optional(),
    before: z.int().min(0).optional(),
    limit: z.int().min(1).max(200).optional(),
    network: McpNetworkSchema.optional(),
  })
  .strict();
export type ListChainEventsInput = z.infer<typeof ListChainEventsInputSchema>;

// objectItems(...) properties, none required at the item level. observed_at
// is a fully untyped ANY here in the hand-written original -- NOT the
// nullable-integer CHAIN_EVENT_ITEM convention batch 8's
// get_block_chain_events/get_extrinsic_chain_events use for the same field
// name; this tool inlines its own item shape rather than sharing that one.
const ChainEventFeedItemSchema = z
  .object({
    block_number: z.int().nullable().optional(),
    event_index: z.int().nullable().optional(),
    pallet: z.string().nullable().optional(),
    method: z.string().nullable().optional(),
    args: z.unknown().optional(),
    phase: z.unknown().optional(),
    extrinsic_index: z.int().nullable().optional(),
    observed_at: z.unknown().optional(),
    // #8525: deterministic human-readable action sentence for this event's
    // pallet.method, or null when no template matches -- never a
    // guessed/partial sentence.
    summary: z.string().nullable().optional(),
  })
  .passthrough();

export const ListChainEventsOutputSchema = z
  .object({
    count: z.int(),
    next_before: z.int().nullable().optional(),
    next_cursor: z.string().nullable().optional(),
    events: z.array(ChainEventFeedItemSchema),
  })
  .passthrough();
export type ListChainEventsOutput = z.infer<typeof ListChainEventsOutputSchema>;

export const GetNetworkActivityInputSchema = z
  .object({
    window: z.enum(WINDOWS_2).optional(),
  })
  .strict();
export type GetNetworkActivityInput = z.infer<
  typeof GetNetworkActivityInputSchema
>;

// objectItems(...) properties, none required at the item level.
const NetworkActivityDaySchema = z
  .object({
    day: z.string().nullable().optional(),
    block_count: z.int().nullable().optional(),
    extrinsic_count: z.int().nullable().optional(),
    event_count: z.int().nullable().optional(),
    successful_extrinsics: z.int().nullable().optional(),
    success_rate: z.number().nullable().optional(),
    unique_signers: z.int().nullable().optional(),
  })
  .passthrough();

export const GetNetworkActivityOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    window: z.string(),
    observed_at: z.string().nullable().optional(),
    day_count: z.int(),
    days: z.array(NetworkActivityDaySchema),
  })
  .passthrough();
export type GetNetworkActivityOutput = z.infer<
  typeof GetNetworkActivityOutputSchema
>;
