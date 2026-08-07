// MCP tool `get_webhook_subscription` (types-epic E batch 4, #8068). Mirrors
// GET /api/v1/webhooks/subscriptions/{id}.
//
// DERIVED FROM THE ROUTE, NOT COPIED (#9796). This file used to model the
// response itself, with a header explaining there was "no existing Zod schema
// to reuse" -- true when it was written, and no longer true: #9967 documented
// the route and gave it an ArtifactSchema, so the shape moved there and this
// imports it. A route field rename is now a compile error here.
import { z } from "zod";
import { WebhookSubscriptionArtifactSchema } from "../routes/webhooks.ts";

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

export const GetWebhookSubscriptionOutputSchema =
  WebhookSubscriptionArtifactSchema;
export type GetWebhookSubscriptionOutput = z.infer<
  typeof GetWebhookSubscriptionOutputSchema
>;
