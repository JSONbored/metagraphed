/**
 * Static reference copy for the `/webhooks` docs page (#3514).
 *
 * Header names, timing constants, and validation limits mirror
 * `src/webhooks.mjs` and `workers/config.mjs` — keep them in sync when the
 * Worker webhook contract changes. The UI cannot import Worker `.mjs`
 * modules, so these are intentional literals.
 *
 * @see https://github.com/JSONbored/metagraphed/issues/3514
 */

export const WEBHOOKS_BASE_PATH = "/api/v1/webhooks/subscriptions";

/** Keep aligned with WEBHOOK_SIGNATURE_HEADER in src/webhooks.mjs */
export const WEBHOOK_SIGNATURE_HEADER = "x-metagraph-signature";
/** Keep aligned with WEBHOOK_TIMESTAMP_HEADER in src/webhooks.mjs */
export const WEBHOOK_TIMESTAMP_HEADER = "x-metagraph-timestamp";
/** Keep aligned with WEBHOOK_SECRET_HEADER in src/webhooks.mjs */
export const WEBHOOK_SECRET_HEADER = "x-metagraph-webhook-secret";
/** Keep aligned with WEBHOOK_EVENT_ID_HEADER in src/webhooks.mjs */
export const WEBHOOK_EVENT_ID_HEADER = "x-metagraph-event-id";
/** Keep aligned with WEBHOOK_IDEMPOTENCY_HEADER in src/webhooks.mjs */
export const WEBHOOK_IDEMPOTENCY_HEADER = "x-metagraph-idempotency-key";
/** Keep aligned with WEBHOOK_EVENT_TYPE in src/webhooks.mjs */
export const WEBHOOK_EVENT_TYPE = "metagraph.publish";
/** Keep aligned with WEBHOOK_SUBSCRIPTION_TOKEN_HEADER in workers/config.mjs */
export const WEBHOOK_SUBSCRIPTION_TOKEN_HEADER = "x-metagraph-webhook-subscription-token";

/** Keep aligned with WEBHOOK_MAX_DELIVERY_ROUNDS in src/webhooks.mjs */
export const WEBHOOK_MAX_DELIVERY_ROUNDS = 8;
/** Keep aligned with WEBHOOK_REDELIVERY_BASE_MS in src/webhooks.mjs (5 min) */
export const WEBHOOK_REDELIVERY_BASE_MS = 5 * 60 * 1000;
/** Keep aligned with WEBHOOK_REDELIVERY_MAX_MS in src/webhooks.mjs (12 h) */
export const WEBHOOK_REDELIVERY_MAX_MS = 12 * 60 * 60 * 1000;
/** Keep aligned with WEBHOOK_TTL_SECONDS in workers/config.mjs (180 days) */
export const WEBHOOK_TTL_SECONDS = 180 * 24 * 60 * 60;
/** Keep aligned with MAX_WEBHOOK_BODY_BYTES in workers/config.mjs */
export const MAX_WEBHOOK_BODY_BYTES = 8192;

export type WebhookEndpointDoc = {
  method: "POST" | "GET" | "DELETE";
  path: string;
  summary: string;
  auth: string;
};

/** Keep aligned with the route dispatch in handleWebhookRequest (workers/api.mjs). */
export const WEBHOOK_ENDPOINTS: readonly WebhookEndpointDoc[] = [
  {
    method: "POST",
    path: WEBHOOKS_BASE_PATH,
    summary: "Create a subscription for the change-feed publish event.",
    auth: `${WEBHOOK_SUBSCRIPTION_TOKEN_HEADER} header`,
  },
  {
    method: "GET",
    path: `${WEBHOOKS_BASE_PATH}/{id}`,
    summary: "Read a subscription's public fields and delivery health.",
    auth: "none",
  },
  {
    method: "DELETE",
    path: `${WEBHOOKS_BASE_PATH}/{id}`,
    summary: "Remove a subscription.",
    auth: `${WEBHOOK_SECRET_HEADER} header (the subscription's own secret)`,
  },
] as const;

/** Expected endpoint count — guards accidental drift. */
export const WEBHOOK_ENDPOINT_COUNT = 3;

export type WebhookFilterFieldDoc = {
  field: string;
  type: string;
  detail: string;
};

/** Keep aligned with normalizeFilters in src/webhooks.mjs. */
export const WEBHOOK_FILTER_FIELDS: readonly WebhookFilterFieldDoc[] = [
  {
    field: "netuids",
    type: "integer[] (0-65535, max 64)",
    detail:
      "Only deliver events touching one of these subnets. Duplicates are deduped; an empty array matches zero subnets, not all of them.",
  },
  {
    field: "kinds",
    type: '("subnets" | "artifacts")[] (max 8)',
    detail:
      "Only deliver events carrying one of these change kinds. An empty array matches zero kinds, not all of them.",
  },
] as const;

/** Redelivery backoff, in whole seconds, for a given failed round (1-indexed). */
export function webhookRedeliveryDelaySeconds(round: number): number {
  const delayMs = Math.min(
    WEBHOOK_REDELIVERY_BASE_MS * 2 ** (round - 1),
    WEBHOOK_REDELIVERY_MAX_MS,
  );
  return Math.round(delayMs / 1000);
}

export function buildWebhookCurlExample(apiBase: string, url = "https://example.com/hook"): string {
  const base = apiBase.replace(/\/$/, "");
  return [
    `curl -s -X POST '${base}${WEBHOOKS_BASE_PATH}' \\`,
    `  -H 'content-type: application/json' \\`,
    `  -H '${WEBHOOK_SUBSCRIPTION_TOKEN_HEADER}: <your-token>' \\`,
    `  -d '{"url":"${url}","filters":{"netuids":[1,43]}}'`,
  ].join("\n");
}
