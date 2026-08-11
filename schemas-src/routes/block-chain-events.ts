// GET /api/v1/blocks/{ref}/chain-events (types-epic B batch 7, #8061).
// Originally the Postgres-backed all-events tier (ADR 0013), proxied verbatim
// from the DATA_API service Worker. It is now served locally from two tiers --
// the live-follow D1 lane above the decode seam (#9208) and chain.chain_events
// in the lakehouse at or below it (#9260) -- through one formatter, so the
// PAYLOAD shape this file models is unchanged and tier-independent. Modeled
// from the original workers/data-api.ts inline SQL handler
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
import { ChainEventSchema as NetworkChainEventSchema } from "./chain-events.ts";

// The network-wide route's own row, with the ONE delta this route has: the
// block is in the PATH, so a row here need not repeat it (#10790).
const ChainEventSchema = NetworkChainEventSchema.extend({
  block_number: z.int().nullable().optional(),
});

export const BlockChainEventsArtifactSchema = z
  .object({
    block_number: z.int().min(0),
    count: z.int().min(0),
    events: z.array(ChainEventSchema),
  })
  .strict();
export type BlockChainEventsArtifact = z.infer<
  typeof BlockChainEventsArtifactSchema
>;
