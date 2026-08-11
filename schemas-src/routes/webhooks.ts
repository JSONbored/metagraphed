// GET /api/v1/webhooks/subscriptions/{id} (#9967).
//
// Served live from METAGRAPH_CONTROL, no static file: the response is one
// subscriber's own record plus the recent delivery outcomes the queue wrote
// beside it, so a stored copy would be a stale copy.
//
// WHY THIS FILE EXISTS. The route has been served since webhooks shipped and
// was absent from openapi.json until now, while `get_webhook_subscription`'s
// own description named the path -- so we were telling agents to call an
// endpoint our published contract did not describe. The shape was already
// modelled, but on the MCP side; this makes the ROUTE the owner and the tool
// the importer, which is the direction #9796 settled on.
import { z } from "zod";
import { OpenObjectSchema } from "../mcp-tools/shared.ts";

/**
 * The most recent failure, when there is one.
 *
 * Written by `deliveryRecordFor` in workers/api.ts, which sits next to the
 * summariser that reads it -- they were spelled out separately once and drifted
 * into disjoint vocabularies while every test still passed, so both sides are
 * modelled here from the writer.
 */
const WebhookDeliveryFailureSchema = z
  .object({
    event_id: z.string().optional(),
    attempts: z.int().optional(),
    reason: z.string().nullable().optional(),
    status_code: z.int().nullable().optional(),
    state: z.string().optional(),
    last_attempt_at: z.string().nullable().optional(),
    next_attempt_at: z.string().nullable().optional(),
  })
  .passthrough();

const WebhookDeliveryStatusSchema = z
  .object({
    // `retrying` is not a failure: the queue schedules the retry, and the
    // subscriber has not lost the event. `dead_letter` is the one that means
    // an event will never arrive.
    status: z.enum(["ok", "retrying", "dead_letter"]),
    pending: z.int(),
    dead_letter: z.int(),
    last_failure: WebhookDeliveryFailureSchema.nullable().optional(),
  })
  .passthrough();

export const WebhookSubscriptionArtifactSchema = z
  .object({
    id: z.string(),
    url: z.string(),
    // Caller-supplied and echoed back: the server does not define this shape
    // because the caller does. Declared open on the opacity gate for that
    // reason, not by omission.
    filters: OpenObjectSchema.optional(),
    created_at: z.string().nullable().optional(),
    active: z.boolean(),
    // Absent on a subscription that has never had a delivery attempted.
    delivery: WebhookDeliveryStatusSchema.optional(),
  })
  .passthrough();
export type WebhookSubscriptionArtifact = z.infer<
  typeof WebhookSubscriptionArtifactSchema
>;
