import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import { handleRequest } from "../workers/api.mjs";
import type { Row } from "./row-type.ts";

// Minimal in-memory KV mock matching the Workers KV surface the worker uses.
function makeKv() {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string, options?: { type?: string }) {
      const value = store.get(key);
      if (value === undefined) return null;
      return options?.type === "json" ? JSON.parse(value) : value;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list({ prefix, limit }: { prefix?: string; limit?: number } = {}) {
      const keys = [...store.keys()]
        .filter((key) => !prefix || key.startsWith(prefix))
        .slice(0, Number.isFinite(limit) ? limit : undefined)
        .map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  };
}

const SUBSCRIPTION_TOKEN = "test-webhook-subscription-token";
const envWith = (kv: unknown, extra: Row = {}) =>
  createLocalArtifactEnv({
    METAGRAPH_CONTROL: kv,
    METAGRAPH_WEBHOOK_SUBSCRIPTION_TOKEN: SUBSCRIPTION_TOKEN,
    ...extra,
  });
const req = (path: string, init?: RequestInit) =>
  new Request(`https://metagraph.sh${path}`, init);
const postSub = (env: Row, body: unknown) =>
  handleRequest(
    req("/api/v1/webhooks/subscriptions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-metagraph-webhook-subscription-token": SUBSCRIPTION_TOKEN,
      },
      body: JSON.stringify(body),
    }),
    env,
    {},
  );

describe("webhook subscription routes", () => {
  test("creates a subscription and stores it in KV", async () => {
    const kv = makeKv();
    const res = await postSub(envWith(kv), {
      url: "https://hooks.example.com/mg",
      filters: { netuids: [7] },
    });
    assert.equal(res.status, 201);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.match(body.data.id, /^[0-9a-f-]{36}$/);
    assert.match(body.data.secret, /^[0-9a-f]{64}$/);
    assert.deepEqual(body.data.filters, { netuids: [7] });
    assert.equal(body.data.delivery.signature_header, "x-metagraph-signature");
    // Persisted under the prefix.
    assert.equal(kv.store.has(`webhooks:sub:${body.data.id}`), true);
  });

  test("honors a caller-provided secret", async () => {
    const kv = makeKv();
    const res = await postSub(envWith(kv), {
      url: "https://hooks.example.com/mg",
      secret: "my-very-own-secret-value",
    });
    assert.equal((await res.json()).data.secret, "my-very-own-secret-value");
  });

  test("rejects a private/non-https URL with 400", async () => {
    const res = await postSub(envWith(makeKv()), {
      url: "https://169.254.169.254/latest/meta-data",
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "invalid_subscription");
  });

  test("rejects invalid JSON with 400", async () => {
    const res = await handleRequest(
      req("/api/v1/webhooks/subscriptions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-metagraph-webhook-subscription-token": SUBSCRIPTION_TOKEN,
        },
        body: "{not json",
      }),
      envWith(makeKv()),
      {},
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "invalid_json");
  });

  test("rejects subscription creation without the subscription token", async () => {
    const res = await handleRequest(
      req("/api/v1/webhooks/subscriptions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://hooks.example.com/mg" }),
      }),
      envWith(makeKv()),
      {},
    );
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, "unauthorized");
  });

  // Security hardening (#3: authenticate BEFORE touching the untrusted payload).
  // A request with a bad/missing token AND a malformed body must fail with the
  // AUTH error (401), not the body-validation error (400). A 400 here would mean
  // the worker parsed/validated attacker input before checking auth.
  test("auth runs first: bad token + malformed body returns 401, not a 400 body error", async () => {
    const kv = makeKv();
    const res = await handleRequest(
      req("/api/v1/webhooks/subscriptions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-metagraph-webhook-subscription-token": "wrong-token",
        },
        body: "{not even json",
      }),
      envWith(kv),
      {},
    );
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, "unauthorized");
    // Nothing should have been persisted for an unauthenticated caller.
    assert.equal(kv.store.size, 0);
  });

  test("missing token + malformed body still returns 401 (no body parsing leaked)", async () => {
    const res = await handleRequest(
      req("/api/v1/webhooks/subscriptions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "}{ broken",
      }),
      envWith(makeKv()),
      {},
    );
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, "unauthorized");
  });

  // The reorder must NOT break the authenticated body path: a VALID token with a
  // malformed body still surfaces the JSON error, and a valid token + valid body
  // still processes (covered by the create test above).
  test("valid token + malformed body still returns the 400 body error", async () => {
    const res = await handleRequest(
      req("/api/v1/webhooks/subscriptions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-metagraph-webhook-subscription-token": SUBSCRIPTION_TOKEN,
        },
        body: "{not json",
      }),
      envWith(makeKv()),
      {},
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "invalid_json");
  });

  test("disables subscription creation when the subscription token is unconfigured", async () => {
    const kv = makeKv();
    const res = await handleRequest(
      req("/api/v1/webhooks/subscriptions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-metagraph-webhook-subscription-token": SUBSCRIPTION_TOKEN,
        },
        body: JSON.stringify({ url: "https://hooks.example.com/mg" }),
      }),
      envWith(kv, { METAGRAPH_WEBHOOK_SUBSCRIPTION_TOKEN: "" }),
      {},
    );
    assert.equal(res.status, 503);
    assert.equal(
      (await res.json()).error.code,
      "webhook_subscriptions_disabled",
    );
    assert.equal(kv.store.size, 0);
  });

  test("returns 503 when the KV store is unbound", async () => {
    const res = await postSub(createLocalArtifactEnv(), {
      url: "https://hooks.example.com/mg",
    });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, "webhooks_unavailable");
  });

  test("GET returns the subscription without the secret", async () => {
    const kv = makeKv();
    const created = await (
      await postSub(envWith(kv), {
        url: "https://hooks.example.com/mg",
      })
    ).json();
    const res = await handleRequest(
      req(`/api/v1/webhooks/subscriptions/${created.data.id}`),
      envWith(kv),
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.url, "https://hooks.example.com/mg");
    assert.equal(body.data.secret, undefined);
    // A healthy subscription with no parked deliveries reports "ok".
    assert.deepEqual(body.data.delivery, {
      status: "ok",
      pending: 0,
      dead_letter: 0,
      last_failure: null,
    });
  });

  test("GET surfaces parked-delivery health (retrying + dead-letter)", async () => {
    const kv = makeKv();
    const created = await (
      await postSub(envWith(kv), { url: "https://hooks.example.com/mg" })
    ).json();
    const id = created.data.id;
    kv.store.set(
      `webhooks:delivery:${id}:event-pending`,
      JSON.stringify({
        subscription_id: id,
        event_id: "event-pending",
        state: "pending",
        round: 1,
        reason: "timeout",
        last_attempt_at: "2026-06-22T00:00:00.000Z",
        next_attempt_at: "2026-06-22T00:05:00.000Z",
      }),
    );
    kv.store.set(
      `webhooks:delivery:${id}:event-dead`,
      JSON.stringify({
        subscription_id: id,
        event_id: "event-dead",
        state: "dead",
        round: 8,
        reason: "http-503",
        status_code: 503,
        last_attempt_at: "2026-06-22T01:00:00.000Z",
        next_attempt_at: null,
      }),
    );

    const res = await handleRequest(
      req(`/api/v1/webhooks/subscriptions/${id}`),
      envWith(kv),
      {},
    );
    const { delivery } = (await res.json()).data;
    assert.equal(delivery.status, "dead_letter");
    assert.equal(delivery.pending, 1);
    assert.equal(delivery.dead_letter, 1);
    assert.equal(delivery.last_failure.event_id, "event-dead"); // latest attempt
    assert.equal(delivery.last_failure.attempts, 8);
    assert.equal(delivery.last_failure.reason, "http-503");
  });

  test("GET delivery health limits parked-delivery KV work", async () => {
    const kv = makeKv();
    const seen: Row[] = [];
    const originalList = kv.list;
    kv.list = async (options: { prefix?: string; limit?: number }) => {
      seen.push(options);
      return originalList(options);
    };
    const created = await (
      await postSub(envWith(kv), { url: "https://hooks.example.com/mg" })
    ).json();
    const id = created.data.id;
    for (let i = 0; i < 300; i += 1) {
      kv.store.set(
        `webhooks:delivery:${id}:event-${i}`,
        JSON.stringify({
          subscription_id: id,
          event_id: `event-${i}`,
          state: "pending",
          round: 1,
          last_attempt_at: "2026-06-22T00:00:00.000Z",
        }),
      );
    }

    const res = await handleRequest(
      req(`/api/v1/webhooks/subscriptions/${id}`),
      envWith(kv),
      {},
    );

    assert.equal(res.status, 200);
    assert.equal(seen[0].limit, 256);
    assert.equal((await res.json()).data.delivery.pending, 256);
  });

  test("GET delivery health degrades to ok when the store lacks list()", async () => {
    const kv = makeKv();
    delete (kv as Row).list; // local-dev KV mock without list support
    const created = await (
      await postSub(envWith(kv), { url: "https://hooks.example.com/mg" })
    ).json();
    const res = await handleRequest(
      req(`/api/v1/webhooks/subscriptions/${created.data.id}`),
      envWith(kv),
      {},
    );
    assert.equal((await res.json()).data.delivery.status, "ok");
  });

  test("GET delivery health degrades to ok when a KV list throws", async () => {
    const kv = makeKv();
    const created = await (
      await postSub(envWith(kv), { url: "https://hooks.example.com/mg" })
    ).json();
    kv.list = async () => {
      throw new Error("kv list down");
    };
    const res = await handleRequest(
      req(`/api/v1/webhooks/subscriptions/${created.data.id}`),
      envWith(kv),
      {},
    );
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.delivery.status, "ok");
  });

  test("DELETE requires the matching secret", async () => {
    const kv = makeKv();
    const created = await (
      await postSub(envWith(kv), {
        url: "https://hooks.example.com/mg",
      })
    ).json();
    const id = created.data.id;

    const denied = await handleRequest(
      req(`/api/v1/webhooks/subscriptions/${id}`, {
        method: "DELETE",
        headers: { "x-metagraph-webhook-secret": "wrong" },
      }),
      envWith(kv),
      {},
    );
    assert.equal(denied.status, 403);
    assert.equal(kv.store.has(`webhooks:sub:${id}`), true);

    const ok = await handleRequest(
      req(`/api/v1/webhooks/subscriptions/${id}`, {
        method: "DELETE",
        headers: { "x-metagraph-webhook-secret": created.data.secret },
      }),
      envWith(kv),
      {},
    );
    assert.equal(ok.status, 200);
    assert.equal(kv.store.has(`webhooks:sub:${id}`), false);
  });

  test("404 for an unknown subscription id", async () => {
    const res = await handleRequest(
      req(
        "/api/v1/webhooks/subscriptions/00000000-0000-4000-8000-000000000000",
      ),
      envWith(makeKv()),
      {},
    );
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, "subscription_not_found");
  });

  test("OPTIONS preflight advertises the webhook methods", async () => {
    const res = await handleRequest(
      req("/api/v1/webhooks/subscriptions", { method: "OPTIONS" }),
      envWith(makeKv()),
      {},
    );
    assert.equal(res.status, 204);
    assert.match(res.headers.get("access-control-allow-methods"), /DELETE/);
    assert.match(
      res.headers.get("access-control-allow-headers"),
      /x-metagraph-webhook-secret/,
    );
  });
});

// #5473: create + delete are gated by WEBHOOK_SUBSCRIPTION_RATE_LIMITER (a
// no-op when the binding is absent). Mirrors the alert-trigger-create suite:
// within-limit success, over-limit 429 with the standard header family, and
// unbound-binding no-op.
describe("webhook subscription rate limiting", () => {
  const allow = () => ({ limit: vi.fn(async () => ({ success: true })) });
  const reject = () => ({ limit: vi.fn(async () => ({ success: false })) });

  test("create: 429 with the rate-limit header family when the limiter rejects, and nothing is persisted", async () => {
    const kv = makeKv();
    const limiter = reject();
    const res = await postSub(
      envWith(kv, { WEBHOOK_SUBSCRIPTION_RATE_LIMITER: limiter }),
      { url: "https://hooks.example.com/mg" },
    );
    assert.equal(res.status, 429);
    assert.equal(
      (await res.json()).error.code,
      "webhook_subscription_rate_limited",
    );
    assert.equal(res.headers.get("retry-after"), "60");
    assert.equal(res.headers.get("x-ratelimit-limit"), "10");
    assert.equal(res.headers.get("x-ratelimit-policy"), "10;w=60");
    assert.equal(res.headers.get("x-ratelimit-remaining"), "0");
    assert.equal(limiter.limit.mock.calls.length, 1);
    // No KV row written for a rate-limited create.
    assert.equal(kv.store.size, 0);
  });

  test("create: 201 when the limiter allows the request", async () => {
    const kv = makeKv();
    const limiter = allow();
    const res = await postSub(
      envWith(kv, { WEBHOOK_SUBSCRIPTION_RATE_LIMITER: limiter }),
      { url: "https://hooks.example.com/mg" },
    );
    assert.equal(res.status, 201);
    assert.equal(limiter.limit.mock.calls.length, 1);
  });

  test("create: skips the limiter entirely when the binding is unbound (local dev/CI)", async () => {
    const res = await postSub(envWith(makeKv()), {
      url: "https://hooks.example.com/mg",
    });
    assert.equal(res.status, 201);
  });

  test("create: rejects unauthenticated callers before consulting the limiter", async () => {
    const limiter = reject();
    const res = await handleRequest(
      req("/api/v1/webhooks/subscriptions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://hooks.example.com/mg" }),
      }),
      envWith(makeKv(), { WEBHOOK_SUBSCRIPTION_RATE_LIMITER: limiter }),
      {},
    );
    assert.equal(res.status, 401);
    assert.equal(limiter.limit.mock.calls.length, 0);
  });

  test("delete: 429 when the limiter rejects, and the subscription survives", async () => {
    const kv = makeKv();
    const created = await (
      await postSub(envWith(kv), { url: "https://hooks.example.com/mg" })
    ).json();
    const id = created.data.id;
    const limiter = reject();
    const res = await handleRequest(
      req(`/api/v1/webhooks/subscriptions/${id}`, {
        method: "DELETE",
        headers: { "x-metagraph-webhook-secret": created.data.secret },
      }),
      envWith(kv, { WEBHOOK_SUBSCRIPTION_RATE_LIMITER: limiter }),
      {},
    );
    assert.equal(res.status, 429);
    assert.equal(limiter.limit.mock.calls.length, 1);
    assert.equal(kv.store.has(`webhooks:sub:${id}`), true);
  });

  test("delete: 200 when the limiter allows the request", async () => {
    const kv = makeKv();
    const created = await (
      await postSub(envWith(kv), { url: "https://hooks.example.com/mg" })
    ).json();
    const id = created.data.id;
    const limiter = allow();
    const res = await handleRequest(
      req(`/api/v1/webhooks/subscriptions/${id}`, {
        method: "DELETE",
        headers: { "x-metagraph-webhook-secret": created.data.secret },
      }),
      envWith(kv, { WEBHOOK_SUBSCRIPTION_RATE_LIMITER: limiter }),
      {},
    );
    assert.equal(res.status, 200);
    assert.equal(limiter.limit.mock.calls.length, 1);
    assert.equal(kv.store.has(`webhooks:sub:${id}`), false);
  });
});

describe("SSE change feed", () => {
  test("GET /api/v1/events emits a snapshot event", async () => {
    const res = await handleRequest(
      req("/api/v1/events"),
      envWith(makeKv()),
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/event-stream/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const text = await res.text();
    assert.match(text, /event: snapshot/);
    assert.match(text, /retry: 300000/);
    const dataLine = text
      .split("\n")
      .find((line: string) => line.startsWith("data: "));
    const event = JSON.parse(dataLine!.slice("data: ".length));
    assert.equal(event.type, "metagraph.publish");
    assert.ok(Array.isArray(event.affected_netuids));
  });

  test("Last-Event-ID matching the current snapshot short-circuits to a keepalive", async () => {
    const env = envWith(makeKv());
    const first = await handleRequest(req("/api/v1/events"), env, {});
    const firstText = await first.text();
    assert.equal(first.headers.get("x-metagraph-events"), "snapshot");
    const idLine = firstText
      .split("\n")
      .find((line: string) => line.startsWith("id: "));
    const eventId = idLine!.slice("id: ".length);

    const reconnect = await handleRequest(
      req("/api/v1/events", { headers: { "last-event-id": eventId } }),
      env,
      {},
    );
    assert.equal(reconnect.status, 200);
    assert.equal(reconnect.headers.get("x-metagraph-events"), "unchanged");
    const reconnectText = await reconnect.text();
    // No snapshot frame — just a retry directive and a keepalive comment.
    assert.doesNotMatch(reconnectText, /event: snapshot/);
    assert.doesNotMatch(reconnectText, /^data:/m);
    assert.match(reconnectText, /retry: 300000/);
    assert.match(reconnectText, /^: /m);
  });

  test("a stale Last-Event-ID still delivers the snapshot", async () => {
    const res = await handleRequest(
      req("/api/v1/events", { headers: { "last-event-id": "stale-id" } }),
      envWith(makeKv()),
      {},
    );
    assert.equal(res.headers.get("x-metagraph-events"), "snapshot");
    assert.match(await res.text(), /event: snapshot/);
  });
});

describe("webhook route edge cases", () => {
  test("404 for an unknown webhook sub-route", async () => {
    const res = await handleRequest(
      req("/api/v1/webhooks/not-subscriptions"),
      envWith(makeKv()),
      {},
    );
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, "not_found");
  });

  test("405 for an unsupported method on the collection root", async () => {
    // PUT has an id-less collection path but is neither POST (create) nor a
    // GET/DELETE on an id, so it hits the method_not_allowed tail.
    const res = await handleRequest(
      req("/api/v1/webhooks/subscriptions", { method: "PATCH" }),
      envWith(makeKv()),
      {},
    );
    assert.equal(res.status, 405);
    assert.equal((await res.json()).error.code, "method_not_allowed");
    assert.match(res.headers.get("allow"), /POST, GET, DELETE/);
  });

  test("413 when the content-length header exceeds the body limit", async () => {
    const res = await handleRequest(
      req("/api/v1/webhooks/subscriptions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(9000),
          "x-metagraph-webhook-subscription-token": SUBSCRIPTION_TOKEN,
        },
        body: JSON.stringify({ url: "https://hooks.example.com/mg" }),
      }),
      envWith(makeKv()),
      {},
    );
    assert.equal(res.status, 413);
    assert.equal((await res.json()).error.code, "payload_too_large");
  });

  test("413 when the decoded body byte length exceeds the limit", async () => {
    // content-length omitted, but the JSON payload itself is oversized.
    const body = JSON.stringify({
      url: "https://hooks.example.com/mg",
      pad: "x".repeat(9000),
    });
    const res = await handleRequest(
      req("/api/v1/webhooks/subscriptions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-metagraph-webhook-subscription-token": SUBSCRIPTION_TOKEN,
        },
        body,
      }),
      envWith(makeKv()),
      {},
    );
    assert.equal(res.status, 413);
    assert.equal((await res.json()).error.code, "payload_too_large");
  });

  test("503 when KV put fails during creation", async () => {
    const kv = makeKv();
    kv.put = async () => {
      throw new Error("kv put down");
    };
    const res = await postSub(envWith(kv), {
      url: "https://hooks.example.com/mg",
    });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, "webhooks_unavailable");
  });

  test("400 invalid_subscription_id on GET with a malformed id", async () => {
    const res = await handleRequest(
      req("/api/v1/webhooks/subscriptions/not-a-uuid"),
      envWith(makeKv()),
      {},
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "invalid_subscription_id");
  });

  test("400 invalid_subscription_id on DELETE with a malformed id", async () => {
    const res = await handleRequest(
      req("/api/v1/webhooks/subscriptions/not-a-uuid", { method: "DELETE" }),
      envWith(makeKv()),
      {},
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "invalid_subscription_id");
  });

  test("404 on DELETE of an unknown subscription id", async () => {
    const res = await handleRequest(
      req(
        "/api/v1/webhooks/subscriptions/00000000-0000-4000-8000-000000000000",
        {
          method: "DELETE",
          headers: { "x-metagraph-webhook-secret": "whatever" },
        },
      ),
      envWith(makeKv()),
      {},
    );
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, "subscription_not_found");
  });

  test("503 when KV delete fails", async () => {
    const kv = makeKv();
    const created = await (
      await postSub(envWith(kv), { url: "https://hooks.example.com/mg" })
    ).json();
    kv.delete = async () => {
      throw new Error("kv delete down");
    };
    const res = await handleRequest(
      req(`/api/v1/webhooks/subscriptions/${created.data.id}`, {
        method: "DELETE",
        headers: { "x-metagraph-webhook-secret": created.data.secret },
      }),
      envWith(kv),
      {},
    );
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, "webhooks_unavailable");
  });

  test("readWebhookSubscription swallows a throwing KV get → 404", async () => {
    const kv = makeKv();
    kv.get = async () => {
      throw new Error("kv get down");
    };
    const res = await handleRequest(
      req(
        "/api/v1/webhooks/subscriptions/00000000-0000-4000-8000-000000000000",
      ),
      envWith(kv),
      {},
    );
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, "subscription_not_found");
  });
});
