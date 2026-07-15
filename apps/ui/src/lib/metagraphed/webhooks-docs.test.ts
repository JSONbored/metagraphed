import { describe, expect, it } from "vitest";
import {
  MAX_WEBHOOK_BODY_BYTES,
  WEBHOOKS_BASE_PATH,
  WEBHOOK_ENDPOINTS,
  WEBHOOK_ENDPOINT_COUNT,
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_EVENT_TYPE,
  WEBHOOK_FILTER_FIELDS,
  WEBHOOK_IDEMPOTENCY_HEADER,
  WEBHOOK_MAX_DELIVERY_ROUNDS,
  WEBHOOK_REDELIVERY_BASE_MS,
  WEBHOOK_REDELIVERY_MAX_MS,
  WEBHOOK_SECRET_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_SUBSCRIPTION_TOKEN_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  WEBHOOK_TTL_SECONDS,
  buildWebhookCurlExample,
  webhookRedeliveryDelaySeconds,
} from "./webhooks-docs";

describe("webhooks docs reference (#3514)", () => {
  it("keeps Worker-aligned header names", () => {
    expect(WEBHOOK_SIGNATURE_HEADER).toBe("x-metagraph-signature");
    expect(WEBHOOK_TIMESTAMP_HEADER).toBe("x-metagraph-timestamp");
    expect(WEBHOOK_SECRET_HEADER).toBe("x-metagraph-webhook-secret");
    expect(WEBHOOK_EVENT_ID_HEADER).toBe("x-metagraph-event-id");
    expect(WEBHOOK_IDEMPOTENCY_HEADER).toBe("x-metagraph-idempotency-key");
    expect(WEBHOOK_SUBSCRIPTION_TOKEN_HEADER).toBe("x-metagraph-webhook-subscription-token");
  });

  it("keeps the Worker-aligned event type", () => {
    expect(WEBHOOK_EVENT_TYPE).toBe("metagraph.publish");
  });

  it("keeps Worker-aligned retry/delivery constants", () => {
    expect(WEBHOOK_MAX_DELIVERY_ROUNDS).toBe(8);
    expect(WEBHOOK_REDELIVERY_BASE_MS).toBe(5 * 60 * 1000);
    expect(WEBHOOK_REDELIVERY_MAX_MS).toBe(12 * 60 * 60 * 1000);
    expect(WEBHOOK_TTL_SECONDS).toBe(180 * 24 * 60 * 60);
    expect(MAX_WEBHOOK_BODY_BYTES).toBe(8192);
  });

  it("documents every endpoint exactly once", () => {
    expect(WEBHOOK_ENDPOINTS).toHaveLength(WEBHOOK_ENDPOINT_COUNT);
    const methods = WEBHOOK_ENDPOINTS.map((e) => `${e.method} ${e.path}`);
    expect(methods).toEqual([
      "POST /api/v1/webhooks/subscriptions",
      "GET /api/v1/webhooks/subscriptions/{id}",
      "DELETE /api/v1/webhooks/subscriptions/{id}",
    ]);
    expect(new Set(methods).size).toBe(methods.length);
  });

  it("documents the netuids/kinds filter fields", () => {
    expect(WEBHOOK_FILTER_FIELDS.map((f) => f.field)).toEqual(["netuids", "kinds"]);
  });

  it("computes the exponential redelivery schedule, capped at the max", () => {
    expect(webhookRedeliveryDelaySeconds(1)).toBe(5 * 60);
    expect(webhookRedeliveryDelaySeconds(2)).toBe(10 * 60);
    expect(webhookRedeliveryDelaySeconds(3)).toBe(20 * 60);
    // base * 2^7 = 5min * 128 = 640min = 38400s, which exceeds the 12h (43200s)
    // cap only once round grows further; round 8 is still under the cap.
    expect(webhookRedeliveryDelaySeconds(8)).toBe(Math.min(5 * 60 * 2 ** 7, 12 * 60 * 60));
    // A far-future round clamps at the 12h max, never exceeding it.
    expect(webhookRedeliveryDelaySeconds(20)).toBe(12 * 60 * 60);
  });

  it("builds a curl example against the real subscription path", () => {
    const curl = buildWebhookCurlExample("https://api.metagraph.sh/");
    expect(curl).toContain("https://api.metagraph.sh/api/v1/webhooks/subscriptions");
    expect(curl).toContain(WEBHOOK_SUBSCRIPTION_TOKEN_HEADER);
    expect(curl).toContain("POST");
    expect(curl).not.toContain("//api/v1");
  });

  it("exposes the base path used by every endpoint", () => {
    expect(WEBHOOKS_BASE_PATH).toBe("/api/v1/webhooks/subscriptions");
    for (const endpoint of WEBHOOK_ENDPOINTS) {
      expect(endpoint.path.startsWith(WEBHOOKS_BASE_PATH)).toBe(true);
    }
  });
});
