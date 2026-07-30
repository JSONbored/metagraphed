// GET /api/v1/chain-events + /api/v1/chain-events/stats (types-epic B
// batch 6, #8060). Postgres-backed all-events tier (ADR 0013), proxied
// verbatim from the DATA_API service Worker (workers/data-api.ts) -- no
// local D1 read, no local pure builder to drive directly (unlike every
// other route in this epic). Modeled from workers/data-api.ts's inline SQL
// handlers for these two paths (search "GET /api/v1/chain-events" in that
// file) and cross-checked against the hand-edited ChainEventsFeedArtifact/
// ChainEventsStatsArtifact components they replace AND against a real
// production response captured live via the metagraphed MCP's
// list_chain_events/get_chain_activity tools (which mirror these exact two
// routes) -- see tests/zod-schemas.test.ts's ground-truth block for the
// captured fixtures.
//
// ChainEvent is intentionally NOT converted or deleted in this batch: it
// has 2 referrers (verified via repo-wide $ref grep) -- ChainEventsFeedArtifact
// plus BlockChainEventsArtifact, out of scope until types-epic B batch 7.
// The hand-edited `ChainEvent` component key stays in schemas/components/
// *.schema.json, untouched. ChainEventEntry is intentionally NOT registered
// -- ChainEventsStatsArtifact is its only referrer -- so that hand-edited
// component key becomes fully orphaned.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";

const ChainEventSchema = z
  .object({
    block_number: z.int().nullable(),
    event_index: z.int().nullable(),
    pallet: z.string().nullable(),
    method: z.string().nullable(),
    args: z
      .union([z.record(z.string(), z.unknown()), z.array(z.unknown())])
      .nullable()
      .optional(),
    phase: z.string().nullable().optional(),
    extrinsic_index: z.int().nullable().optional(),
    observed_at: z.int().nullable().optional(),
    // #8525: deterministic human-readable action sentence for this event's
    // pallet.method, or null when no template matches -- never a
    // guessed/partial sentence.
    summary: z.string().nullable().optional(),
  })
  .strict();

export const ChainEventsFeedArtifactSchema = z
  .object({
    count: z.int().min(0),
    next_before: z.int().nullable().optional(),
    next_cursor: z
      .string()
      .max(50)
      .regex(/^\d+\.\d+\.\d+$/)
      .nullable()
      .optional(),
    events: z.array(ChainEventSchema),
  })
  .passthrough();
export type ChainEventsFeedArtifact = z.infer<
  typeof ChainEventsFeedArtifactSchema
>;
export const ChainEventsFeedResponseSchema = successEnvelopeSchema(
  ChainEventsFeedArtifactSchema,
);
export const ChainEventsFeedQuerySchema = z
  .object({
    pallet: z.string().optional(),
    method: z.string().optional(),
    block: z.int().min(0).optional(),
    extrinsic: z.int().min(0).optional(),
    cursor: z.string().optional(),
    before: z.int().min(0).optional(),
    limit: z.int().min(1).max(200).optional(),
    format: z.enum(["json", "csv"]).optional(),
  })
  .strict();
export type ChainEventsFeedQuery = z.infer<typeof ChainEventsFeedQuerySchema>;

const ChainEventEntrySchema = z
  .object({
    pallet: z.string().nullable(),
    method: z.string().nullable(),
    count: z.int().min(0),
  })
  .strict();

export const ChainEventsStatsArtifactSchema = z
  .object({
    window_blocks: z.int().min(1),
    groups: z.int().min(0),
    activity: z.array(ChainEventEntrySchema),
  })
  .passthrough();
export type ChainEventsStatsArtifact = z.infer<
  typeof ChainEventsStatsArtifactSchema
>;
export const ChainEventsStatsResponseSchema = successEnvelopeSchema(
  ChainEventsStatsArtifactSchema,
);
export const ChainEventsStatsQuerySchema = z
  .object({
    blocks: z.int().min(1).max(5000).optional(),
  })
  .strict();
export type ChainEventsStatsQuery = z.infer<typeof ChainEventsStatsQuerySchema>;
