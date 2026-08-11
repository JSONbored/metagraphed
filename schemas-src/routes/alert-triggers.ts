// GET /api/v1/alerts/triggers/{id} (#4984 Part 1, documented by #9967).
//
// Proxied to the DATA_API service binding, which owns the auth (a per-trigger
// owner token) and the routing. No static file: the response is one caller's
// own trigger record.
//
// WHY THIS FILE EXISTS. The route has been served since alerts shipped and was
// absent from openapi.json until now, while `get_alert_trigger`'s own
// description named the path -- so we were telling agents to call an endpoint
// our published contract did not describe. The shape was already modelled, but
// on the MCP side; this makes the ROUTE the owner and the tool the importer,
// which is the direction #9796 settled on.
import { z } from "zod";

export const AlertTriggerArtifactSchema = z
  .object({
    id: z.string(),
    name: z.string().nullable().optional(),
    // Which stream the trigger watches, and the four ways it can narrow that
    // stream. All nullable: a trigger that sets none of them matches every
    // event on its table.
    table_filter: z.string().nullable().optional(),
    netuid: z.int().min(0).max(65535).nullable().optional(),
    event_kind: z.string().nullable().optional(),
    account: z.string().nullable().optional(),
    min_amount_tao: z.number().nullable().optional(),
    channel: z.string().optional(),
    destination: z.string().optional(),
    active: z.boolean(),
    created_at: z.string().nullable().optional(),
    updated_at: z.string().nullable().optional(),
    // null until the trigger has fired once -- distinct from a match_count of
    // 0, which a trigger created and immediately disabled would also show.
    last_matched_at: z.string().nullable().optional(),
    match_count: z.int().optional(),
  })
  .strict();
export type AlertTriggerArtifact = z.infer<typeof AlertTriggerArtifactSchema>;
