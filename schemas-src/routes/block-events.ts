// GET /api/v1/blocks/{ref}/events (types-epic B batch 7, #8061). Live
// account_events store-tier data -- no static file. Modeled from
// src/account-events.ts's buildBlockEvents(), cross-checked against the
// hand-edited BlockEventsArtifact component it replaces. Reuses
// AccountEventSchema from subnet-events.ts (types-epic B batch 1, #8055),
// the same reuse pattern account-events-feed.ts / extrinsics.ts's own
// ExtrinsicDetailArtifact already use.
import { z } from "zod";
import { AccountEventSchema } from "./subnet-events.ts";

export const BlockEventsArtifactSchema = z
  .object({
    schema_version: z.int(),
    ref: z.string().nullable(),
    block_number: z.int().min(0).nullable(),
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
    events: z.array(AccountEventSchema),
  })
  .strict()
  .describe(
    "One block's decoded, account-attributed events list (#6977). Rows are opaque JSON; block_number is null for an unknown ref.",
  );
export type BlockEventsArtifact = z.infer<typeof BlockEventsArtifactSchema>;
