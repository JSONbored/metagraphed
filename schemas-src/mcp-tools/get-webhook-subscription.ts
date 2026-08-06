// MCP tool `get_webhook_subscription` (types-epic E batch 4, #8068). Mirrors
// GET /api/v1/webhooks/subscriptions/{id}, which is not one of
// schemas-src/routes/'s covered pilot routes -- no existing Zod schema to
// reuse. Modeled fresh, matching the hand-written literal it replaces
// field-for-field.
import { z } from "zod";
import { OpenObjectSchema } from "./shared.ts";

export const GetWebhookSubscriptionInputSchema = z
  .object({
    // A UUID v4, and the handler ENFORCES it -- `src/webhooks.ts` mints it with
    // crypto.randomUUID() and validates the shape before using it as a KV key,
    // refusing anything else with "Argument `id` must be a valid subscription
    // id (UUID v4)". So the pattern is PUBLISHED here, unlike `date` above
    // which is annotation-only: this one is a real constraint (#9659).
    //
    // #9645's shared `id` sentence was wrong on both counts: there is no list
    // tool to get it from -- it is returned once, at creation -- and an unknown
    // id is an error, not an empty result.
    id: z
      .uuidv4()
      .describe(
        "The subscription's id, a UUID v4, as returned when the subscription " +
          "was created. There is no listing tool: an id that was not kept " +
          "cannot be recovered. A malformed id is rejected outright.",
      )
      .meta({ examples: ["3f2a1c6e-9b7d-4e21-8c5a-2d4f6b8e0a13"] }),
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
