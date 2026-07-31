// GET /api/v1/blocks/{ref}/chain-events (types-epic B batch 7, #8061).
// Postgres-backed all-events tier (ADR 0013), proxied verbatim from the
// DATA_API service Worker (workers/data-api.ts) -- no local D1 read, no
// local pure builder to drive directly (same situation as batch 6's
// chain-events.ts). Modeled from workers/data-api.ts's inline SQL handler
// for "GET /api/v1/blocks/:n/chain-events" and cross-checked against the
// hand-edited BlockChainEventsArtifact component it replaces. Unlike
// /api/v1/blocks/{ref}/events, this route's {ref} is ALWAYS a numeric
// block_number (the handler's own regex is `/^\/api\/v1\/blocks\/(\d+)\/
// chain-events$/`, no hash-resolution branch), so block_number is never
// null here -- a real bug fix vs the hand-edited nullable typing.
//
// ChainEvent is intentionally NOT converted or deleted in this batch by
// this file alone, but its SECOND (and last) referrer converts here:
// types-epic B batch 6 (#8060) already inlined ChainEvent locally for
// ChainEventsFeedArtifact and left the hand-edited component untouched
// pending this batch. Both referrers now model the shape locally
// (unregistered), so the hand-edited `ChainEvent` component key becomes
// fully orphaned as of this batch.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";

const ChainEventSchema = z
  .object({
    block_number: z.int().nullable().optional(),
    event_index: z.int().nullable(),
    pallet: z.string().nullable(),
    method: z.string().nullable(),
    args: z.record(z.string(), z.unknown()).nullable().optional(),
    phase: z.string().nullable().optional(),
    extrinsic_index: z.int().nullable().optional(),
    observed_at: z.int().nullable().optional(),
    // #8525: deterministic human-readable action sentence for this event's
    // pallet.method, or null when no template matches -- never a
    // guessed/partial sentence.
    summary: z.string().nullable().optional(),
  })
  .strict();

export const BlockChainEventsArtifactSchema = z
  .object({
    block_number: z.int().min(0),
    count: z.int().min(0),
    events: z.array(ChainEventSchema),
  })
  .passthrough();
export type BlockChainEventsArtifact = z.infer<
  typeof BlockChainEventsArtifactSchema
>;
export const BlockChainEventsResponseSchema = successEnvelopeSchema(
  BlockChainEventsArtifactSchema,
);
export const BlockChainEventsQuerySchema = z.object({}).strict();
export type BlockChainEventsQuery = z.infer<typeof BlockChainEventsQuerySchema>;
