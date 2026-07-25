// GET /api/v1/blocks/{ref}/events (types-epic B batch 7, #8061). Live
// account_events D1-tier data -- no static file. Modeled from
// src/account-events.ts's buildBlockEvents(), cross-checked against the
// hand-edited BlockEventsArtifact component it replaces. Reuses
// AccountEventSchema from subnet-events.ts (types-epic B batch 1, #8055),
// the same reuse pattern account-events-feed.ts / extrinsics.ts's own
// ExtrinsicDetailArtifact already use.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";
import { AccountEventSchema } from "./subnet-events.ts";

export const BlockEventsArtifactSchema = z
  .object({
    schema_version: z.int(),
    ref: z.string().nullable(),
    block_number: z.int().min(0).nullable(),
    event_count: z.int().min(0),
    limit: z.int(),
    offset: z.int(),
    events: z.array(AccountEventSchema),
  })
  .passthrough();
export type BlockEventsArtifact = z.infer<typeof BlockEventsArtifactSchema>;
export const BlockEventsResponseSchema = successEnvelopeSchema(
  BlockEventsArtifactSchema,
);
export const BlockEventsQuerySchema = z
  .object({
    limit: z.int().min(1).optional(),
    offset: z.int().min(0).optional(),
    format: z.enum(["json", "csv"]).optional(),
  })
  .strict();
export type BlockEventsQuery = z.infer<typeof BlockEventsQuerySchema>;
