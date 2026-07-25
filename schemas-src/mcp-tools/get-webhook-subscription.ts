// MCP tool `get_webhook_subscription` (types-epic E batch 4, #8068). Mirrors
// GET /api/v1/webhooks/subscriptions/{id}, which is not one of
// schemas-src/routes/'s covered pilot routes -- no existing Zod schema to
// reuse. Modeled fresh, matching the hand-written literal it replaces
// field-for-field.
import { z } from "zod";
import { OpenObjectSchema } from "./shared.ts";

export const GetWebhookSubscriptionInputSchema = z
  .object({
    id: z.string(),
  })
  .strict();
export type GetWebhookSubscriptionInput = z.infer<
  typeof GetWebhookSubscriptionInputSchema
>;

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
    status: z.enum(["ok", "retrying", "dead_letter"]),
    pending: z.int(),
    dead_letter: z.int(),
    last_failure: WebhookDeliveryFailureSchema.nullable().optional(),
  })
  .passthrough();

export const GetWebhookSubscriptionOutputSchema = z
  .object({
    id: z.string(),
    url: z.string(),
    filters: OpenObjectSchema.optional(),
    created_at: z.string().nullable().optional(),
    active: z.boolean(),
    delivery: WebhookDeliveryStatusSchema.optional(),
  })
  .passthrough();
export type GetWebhookSubscriptionOutput = z.infer<
  typeof GetWebhookSubscriptionOutputSchema
>;
