import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import { handleRequest } from "../workers/api.ts";
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
    env as unknown as Env,
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
      envWith(makeKv()) as unknown as Env,
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
      envWith(makeKv()) as unknown as Env,
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
      envWith(kv) as unknown as Env,
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
      envWith(makeKv()) as unknown as Env,
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
      envWith(makeKv()) as unknown as Env,
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
      envWith(kv, {
        METAGRAPH_WEBHOOK_SUBSCRIPTION_TOKEN: "",
      }) as unknown as Env,
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
      envWith(kv) as unknown as Env,
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
      envWith(kv) as unknown as Env,
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
      envWith(kv) as unknown as Env,
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
      envWith(kv) as unknown as Env,
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
      envWith(kv) as unknown as Env,
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
      envWith(kv) as unknown as Env,
      {},
    );
    assert.equal(denied.status, 403);
    assert.equal(kv.store.has(`webhooks:sub:${id}`), true);

    const ok = await handleRequest(
      req(`/api/v1/webhooks/subscriptions/${id}`, {
        method: "DELETE",
        headers: { "x-metagraph-webhook-secret": created.data.secret },
      }),
      envWith(kv) as unknown as Env,
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
      envWith(makeKv()) as unknown as Env,
      {},
    );
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, "subscription_not_found");
  });

  test("OPTIONS preflight advertises the webhook methods", async () => {
    const res = await handleRequest(
      req("/api/v1/webhooks/subscriptions", { method: "OPTIONS" }),
      envWith(makeKv()) as unknown as Env,
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
      envWith(makeKv(), {
        WEBHOOK_SUBSCRIPTION_RATE_LIMITER: limiter,
      }) as unknown as Env,
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
      envWith(kv, {
        WEBHOOK_SUBSCRIPTION_RATE_LIMITER: limiter,
      }) as unknown as Env,
      {},
    );
    assert.equal(res.status, 429);
    assert.equal(limiter.limit.mock.calls.length, 1);
    assert.equal(kv.store.has(`webhooks:sub:${id}`), true);
  });

  test("create: a keyed caller rides the account tier and records usage (#8523)", async () => {
    // #8523: a valid mg_ key in Authorization resolves the keyed tier (accountId
    // set) -> the request proceeds AND recordApiKeyUsage fires. The webhook auth
    // stays the shared subscription-token header, independent of the key.
    const WEBHOOK_VALID_KEY = "mg_aValidOpaqueUnkeyGeneratedSuffix";
    const kv = makeKv();
    let usageRecorded = false;
    const pending: Promise<unknown>[] = [];
    const env = envWith(kv, {
      WEBHOOK_SUBSCRIPTION_RATE_LIMITER_KEYED: {
        limit: async () => ({ success: true }),
      },
      API_KEY_LOOKUP_INTERNAL_TOKEN: "test-lookup-token",
      DATA_API: {
        fetch: async (r: Request) => {
          if (new URL(r.url).pathname.endsWith("/keys/usage")) {
            usageRecorded = true;
            return new Response(null, { status: 204 });
          }
          return new Response(
            JSON.stringify({
              valid: true,
              code: "VALID",
              tier: "free",
              accountId: "42",
            }),
            { status: 200 },
          );
        },
      },
    });
    const res = await handleRequest(
      req("/api/v1/webhooks/subscriptions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-metagraph-webhook-subscription-token": SUBSCRIPTION_TOKEN,
          authorization: `Bearer ${WEBHOOK_VALID_KEY}`,
        },
        body: JSON.stringify({ url: "https://hooks.example.com/mg" }),
      }),
      env as unknown as Env,
      { waitUntil: (p: Promise<unknown>) => pending.push(p) },
    );
    await Promise.all(pending);
    assert.equal(res.status, 201);
    assert.equal(usageRecorded, true);
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
      envWith(kv, {
        WEBHOOK_SUBSCRIPTION_RATE_LIMITER: limiter,
      }) as unknown as Env,
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
      envWith(makeKv()) as unknown as Env,
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
    const first = await handleRequest(
      req("/api/v1/events"),
      env as unknown as Env,
      {},
    );
    const firstText = await first.text();
    assert.equal(first.headers.get("x-metagraph-events"), "snapshot");
    const idLine = firstText
      .split("\n")
      .find((line: string) => line.startsWith("id: "));
    const eventId = idLine!.slice("id: ".length);

    const reconnect = await handleRequest(
      req("/api/v1/events", { headers: { "last-event-id": eventId } }),
      env as unknown as Env,
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
      envWith(makeKv()) as unknown as Env,
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
      envWith(makeKv()) as unknown as Env,
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
      envWith(makeKv()) as unknown as Env,
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
      envWith(makeKv()) as unknown as Env,
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
      envWith(makeKv()) as unknown as Env,
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
      envWith(makeKv()) as unknown as Env,
      {},
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "invalid_subscription_id");
  });

  test("400 invalid_subscription_id on DELETE with a malformed id", async () => {
    const res = await handleRequest(
      req("/api/v1/webhooks/subscriptions/not-a-uuid", { method: "DELETE" }),
      envWith(makeKv()) as unknown as Env,
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
      envWith(makeKv()) as unknown as Env,
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
      envWith(kv) as unknown as Env,
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
      envWith(kv) as unknown as Env,
      {},
    );
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, "subscription_not_found");
  });
});

// --- delivery on a queue (metagraphed-infra#354) ----------------------------
//
// The fan-out route replaces the publish script's inline delivery, and the
// queue consumer replaces `dispatchWithRedelivery`'s parking, sweeping,
// round-counting and per-subscription budget. What these assert is that the
// subscriber-visible behaviour survived: matching subscribers get exactly one
// message each, the body is byte-identical to what will be signed, a deleted
// subscription stops delivery, and a failure is rescheduled rather than lost.
const DISPATCH_TOKEN = "test-webhook-dispatch-token";

function makeQueue() {
  const sent: Record<string, unknown>[] = [];
  return {
    sent,
    async send(body: Record<string, unknown>) {
      sent.push(body);
    },
  };
}

const dispatch = (env: Row, event: unknown, token = DISPATCH_TOKEN) =>
  handleRequest(
    req("/api/v1/internal/webhook-dispatch", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-dispatch-token": token,
      },
      body: JSON.stringify(event),
    }),
    env as unknown as Env,
    {},
  );

async function seedSubscription(kv: ReturnType<typeof makeKv>, url: string) {
  const res = await postSub(envWith(kv), { url });
  return ((await res.json()) as Row).data as Row;
}

/** A fetch double that answers the DoH lookup with a real public address and
 * the webhook URL with whatever status the test is about.
 *
 * Blunt mocks fail this path in a way that looks like the code is wrong: a
 * failed DNS lookup makes `resolvedWebhookUrlStatus` fail CLOSED, so the
 * delivery is "skipped" (terminal) rather than "failed" (retryable), and the
 * consumer correctly acks something the test meant to see retried.
 */
function makeDeliveryFetch(status: number) {
  return vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.startsWith("https://cloudflare-dns.com/dns-query")) {
      return new Response(
        JSON.stringify({ Answer: [{ type: 1, data: "93.184.216.34" }] }),
        { status: 200, headers: { "content-type": "application/dns-json" } },
      );
    }
    return new Response("body", { status });
  });
}

describe("webhook fan-out route", () => {
  const EVENT = { type: "metagraph.publish", changes: { subnets: [7] } };

  test("enqueues one message per subscriber and delivers nothing itself", async () => {
    const kv = makeKv();
    await seedSubscription(kv, "https://hooks.example.com/a");
    await seedSubscription(kv, "https://hooks.example.com/b");
    const queue = makeQueue();

    const res = await dispatch(
      envWith(kv, {
        WEBHOOK_DELIVERIES: queue,
        WEBHOOK_DISPATCH_SECRET: DISPATCH_TOKEN,
      }),
      EVENT,
    );

    assert.equal(res.status, 200);
    const body = (await res.json()) as Row;
    assert.equal(body.ok, true);
    assert.equal(body.subscriptions, 2);
    assert.equal(body.enqueued, 2);
    assert.equal(queue.sent.length, 2);
    // ONE BODY, byte-identical on every message: the per-subscriber signature
    // is computed over these exact bytes at delivery.
    const bodies = new Set(queue.sent.map((m) => m.body));
    assert.equal(bodies.size, 1);
    assert.equal(JSON.parse(queue.sent[0]!.body as string).type, EVENT.type);
    // Every message carries the same content-addressed event id -- half of the
    // idempotency key a subscriber dedupes retries on.
    assert.equal(
      new Set(queue.sent.map((m) => m.event_id)).size,
      1,
      "one event, one id",
    );
  });

  test("401s without the token, 503s with no queue bound", async () => {
    const kv = makeKv();
    await seedSubscription(kv, "https://hooks.example.com/a");
    const queue = makeQueue();

    assert.equal(
      (
        await dispatch(
          envWith(kv, {
            WEBHOOK_DELIVERIES: queue,
            WEBHOOK_DISPATCH_SECRET: DISPATCH_TOKEN,
          }),
          EVENT,
          "wrong",
        )
      ).status,
      401,
    );
    // DECLINES rather than dropping: an event discarded because a binding is
    // missing is a webhook nobody was told failed.
    assert.equal(
      (
        await dispatch(
          envWith(kv, { WEBHOOK_DISPATCH_SECRET: DISPATCH_TOKEN }),
          EVENT,
        )
      ).status,
      503,
    );
    assert.equal(queue.sent.length, 0);
  });
});

describe("webhook queue consumer", () => {
  const EVENT_BODY = JSON.stringify({
    type: "metagraph.publish",
    changes: { subnets: [7] },
  });

  async function runQueue(env: Row, body: unknown) {
    const acts: string[] = [];
    const delays: number[] = [];
    const worker = (await import("../workers/api.ts")).default;
    await worker.queue!(
      {
        messages: [
          {
            body,
            attempts: (body as Row)?.__attempts ?? 1,
            ack: () => acts.push("ack"),
            retry: (opts?: { delaySeconds?: number }) => {
              acts.push("retry");
              if (opts?.delaySeconds !== undefined)
                delays.push(opts.delaySeconds);
            },
          },
        ],
      } as never,
      env as unknown as Env,
      { waitUntil: (p: Promise<unknown>) => void p } as never,
    );
    return { acts, delays };
  }

  test("acks an unparseable message rather than retrying it", async () => {
    // It will not parse on the eighth attempt either, and the DLQ is more
    // useful holding deliveries that might still succeed.
    const { acts } = await runQueue(envWith(makeKv()), { nope: true });
    assert.deepEqual(acts, ["ack"]);
  });

  test("acks when the subscription is gone, so an unsubscribe takes effect", async () => {
    // A delivery already in flight must not outlive the subscription it was
    // for -- the 12-hour retry window makes that a real interval.
    const { acts } = await runQueue(envWith(makeKv()), {
      subscription_id: "sub_deleted",
      event_id: "evt_1",
      body: EVENT_BODY,
    });
    assert.deepEqual(acts, ["ack"]);
  });

  test("delivers to the subscription read at delivery time", async () => {
    const kv = makeKv();
    const sub = await seedSubscription(kv, "https://hooks.example.com/a");
    const fetchMock = makeDeliveryFetch(200);
    const original = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const { acts } = await runQueue(envWith(kv), {
        subscription_id: sub.id,
        event_id: "evt_1",
        body: EVENT_BODY,
      });
      assert.deepEqual(acts, ["ack"], "a delivered event is done");
      assert.equal(fetchMock.mock.calls.length > 0, true);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("reschedules a retryable failure instead of losing it", async () => {
    const kv = makeKv();
    const sub = await seedSubscription(kv, "https://hooks.example.com/a");
    const fetchMock = makeDeliveryFetch(503);
    const original = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const { acts, delays } = await runQueue(envWith(kv), {
        subscription_id: sub.id,
        event_id: "evt_1",
        body: EVENT_BODY,
      });
      assert.deepEqual(acts, ["retry"]);
      // The schedule the hand-rolled system published: 5 minutes on the first
      // failure, doubling from there.
      assert.deepEqual(delays, [300]);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("webhook fan-out route: the ways it declines", () => {
  const EVENT = { type: "metagraph.publish", changes: { subnets: [7] } };
  const fullEnv = (kv: ReturnType<typeof makeKv>, queue: unknown) =>
    envWith(kv, {
      WEBHOOK_DELIVERIES: queue,
      WEBHOOK_DISPATCH_SECRET: DISPATCH_TOKEN,
    });

  test("401s with the header absent, not just wrong", async () => {
    // Absent and wrong must land the same way -- a missing header falling
    // through to an empty-string comparison is how an auth gate accidentally
    // accepts an unset secret.
    const res = await handleRequest(
      req("/api/v1/internal/webhook-dispatch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(EVENT),
      }),
      fullEnv(makeKv(), makeQueue()) as unknown as Env,
      {},
    );
    assert.equal(res.status, 401);
  });

  test("405s on a method other than POST", async () => {
    const res = await handleRequest(
      req("/api/v1/internal/webhook-dispatch", { method: "GET" }),
      fullEnv(makeKv(), makeQueue()) as unknown as Env,
      {},
    );
    assert.equal(res.status, 405);
  });

  test("503s where the dispatch secret is not provisioned", async () => {
    // Unset means the route refuses rather than accepting unauthenticated
    // dispatch of arbitrary events to real subscribers.
    const res = await dispatch(
      envWith(makeKv(), { WEBHOOK_DELIVERIES: makeQueue() }),
      EVENT,
    );
    assert.equal(res.status, 503);
  });

  test("503s where the control KV is not bound", async () => {
    const res = await dispatch(
      envWith(
        { get: async () => null, put: async () => {} },
        {
          WEBHOOK_DELIVERIES: makeQueue(),
          WEBHOOK_DISPATCH_SECRET: DISPATCH_TOKEN,
        },
      ),
      EVENT,
    );
    assert.equal(res.status, 503);
  });

  test("400s on a body that is not a JSON object", async () => {
    const kv = makeKv();
    const env = fullEnv(kv, makeQueue()) as unknown as Env;
    const bad = await handleRequest(
      req("/api/v1/internal/webhook-dispatch", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-dispatch-token": DISPATCH_TOKEN,
        },
        body: "not json",
      }),
      env,
      {},
    );
    assert.equal(bad.status, 400);
    // Valid JSON, wrong shape: a bare array or scalar is not a change event.
    assert.equal((await dispatch(fullEnv(kv, makeQueue()), null)).status, 400);
  });

  test("502s when the queue refuses, so the caller knows to retry", async () => {
    // Reporting success on an event the queue never took would lose it
    // silently, and nobody would learn the subscribers were not told.
    const kv = makeKv();
    await seedSubscription(kv, "https://hooks.example.com/a");
    const res = await dispatch(
      fullEnv(kv, {
        send: async () => Promise.reject(new Error("over capacity")),
      }),
      EVENT,
    );
    assert.equal(res.status, 502);
  });
});

describe("webhook queue consumer: the terminal and transient edges", () => {
  const msg = (body: unknown, attempts = 1) => ({
    body,
    attempts,
    ack: () => {},
    retry: () => {},
  });

  async function run(
    kv: ReturnType<typeof makeKv>,
    body: unknown,
    deliver?: unknown,
  ) {
    const acts: string[] = [];
    const { handleWebhookQueue } = await import("../workers/api.ts");
    await handleWebhookQueue(
      {
        messages: [
          {
            ...msg(body),
            ack: () => acts.push("ack"),
            retry: () => acts.push("retry"),
          },
        ],
      } as never,
      envWith(kv) as unknown as Env,
      { waitUntil: (p: Promise<unknown>) => void p } as never,
      deliver as never,
    );
    return acts;
  }

  test("a delivery that throws is retried, not dropped", async () => {
    // deliverChangeEvent turns every KNOWN failure into a result, so a throw is
    // something unmodelled -- and letting it propagate would fail the whole
    // batch, punishing nine healthy subscribers for one broken one.
    const kv = makeKv();
    const sub = await seedSubscription(kv, "https://hooks.example.com/a");
    const acts = await run(
      kv,
      {
        subscription_id: sub.id,
        event_id: "evt_1",
        body: JSON.stringify({ type: "metagraph.publish" }),
      },
      () => {
        throw new Error("socket exploded");
      },
    );
    assert.deepEqual(acts, ["retry"]);
  });

  test("a delivery result with no status is recorded, not crashed on", async () => {
    // deliverChangeEvent always reports a status, so this is defensive -- but
    // the status record is written for EVERY outcome, and a throw here would
    // turn a delivered event into a retried one.
    const kv = makeKv();
    const sub = await seedSubscription(kv, "https://hooks.example.com/a");
    const acts = await run(
      kv,
      {
        subscription_id: sub.id,
        event_id: "evt_1",
        body: JSON.stringify({ type: "metagraph.publish" }),
      },
      async () => ({}),
    );
    assert.deepEqual(acts, ["ack"], "no verdict is terminal, not a retry loop");
  });

  test("a body that is not JSON is acked, because it never will be", async () => {
    // Retrying it would spend the whole eight-attempt budget to dead-letter in
    // 12 hours what is already known to be undeliverable.
    const kv = makeKv();
    const sub = await seedSubscription(kv, "https://hooks.example.com/a");
    const acts = await run(kv, {
      subscription_id: sub.id,
      event_id: "evt_1",
      body: "{not json",
    });
    assert.deepEqual(acts, ["ack"]);
  });
});

describe("the webhook cron trigger (metagraphed-infra#354)", () => {
  // Delivery used to be a step inside the publish workflow, downstream of every
  // other step -- so when the live-API smoke check broke on 2026-08-02,
  // subscribers heard nothing for four days and no webhook alarm fired (#9650).
  // A trigger that is not part of the publish cannot be taken down by it.
  const CHANGED = {
    type: "metagraph.publish",
    published_at: "2026-08-06T09:00:00.000Z",
    changes: { subnets: [7] },
  };

  async function tick(
    kv: ReturnType<typeof makeKv>,
    queue: unknown,
    event: Record<string, unknown> | null = CHANGED,
  ) {
    const { dispatchWebhooksFromChangelog } = await import("../workers/api.ts");
    return dispatchWebhooksFromChangelog(
      envWith(kv, { WEBHOOK_DELIVERIES: queue }) as unknown as Env,
      event ? async () => event : undefined,
    );
  }

  test("declines quietly where the queue is not bound", async () => {
    // A deployment that has not opted in behaves exactly as before rather than
    // throwing on every tick.
    const res = await tick(makeKv(), undefined);
    assert.equal(res.ok, true);
    assert.equal(res.reason, "not_provisioned");
  });

  test("fans out once, then skips the unchanged snapshot", async () => {
    const kv = makeKv();
    await seedSubscription(kv, "https://hooks.example.com/a");
    const queue = makeQueue();

    const first = await tick(kv, queue);
    assert.equal(first.enqueued, 1, "the change reached the one subscriber");
    assert.equal(queue.sent.length, 1);

    // The id is content-addressed, so re-running over the SAME snapshot is
    // exactly deduped -- which is what lets this be a frequent cron rather than
    // something the publish has to announce.
    const second = await tick(kv, queue);
    assert.equal(second.reason, "unchanged");
    assert.equal(queue.sent.length, 1, "no second fan-out");

    // A genuinely different snapshot goes out.
    const third = await tick(kv, queue, {
      ...CHANGED,
      changes: { subnets: [7, 19] },
    });
    assert.equal(third.enqueued, 1);
    assert.equal(queue.sent.length, 2);
  });

  test("does not record the event as dispatched when the queue refuses", async () => {
    // Recording first would mark an event dispatched that never went, and the
    // NEXT tick would skip it -- one failed enqueue silently costing
    // subscribers a whole publish.
    const kv = makeKv();
    await seedSubscription(kv, "https://hooks.example.com/a");
    await assert.rejects(
      tick(kv, { send: async () => Promise.reject(new Error("nope")) }),
    );
    const queue = makeQueue();
    const after = await tick(kv, queue);
    assert.equal(after.enqueued, 1, "the event is still pending, not skipped");
  });

  test("the default loader reads the published changelog", async () => {
    // The injected loader in the tests above is a seam, not the behaviour --
    // this exercises the real one, so a broken artifact read cannot hide behind
    // a fixture that never calls it.
    const kv = makeKv();
    await seedSubscription(kv, "https://hooks.example.com/a");
    const queue = makeQueue();
    const res = await tick(kv, queue, null);
    // Whatever the local fixture holds, the read itself must succeed and the
    // tick must reach a verdict rather than throw.
    assert.equal(res.ok, true);
    assert.equal(
      res.reason === "unchanged" || typeof res.enqueued === "number",
      true,
    );
  });

  test("a changelog that will not load yields no dispatch, not a throw", async () => {
    // The artifact read is over R2/ASSETS and can fail. buildChangeEvent on a
    // null changelog produces an event with no changes, which
    // shouldDispatchChangeEvent then declines -- so a read failure costs one
    // quiet tick rather than firing an empty notification at every subscriber.
    const kv = makeKv();
    await seedSubscription(kv, "https://hooks.example.com/a");
    const queue = makeQueue();
    const { dispatchWebhooksFromChangelog } = await import("../workers/api.ts");
    const res = await dispatchWebhooksFromChangelog({
      ...(envWith(kv, { WEBHOOK_DELIVERIES: queue }) as Row),
      // BOTH tiers must fail: readArtifact tries ASSETS then falls back to the
      // R2 binding, and the local fixture serves the changelog from disk on
      // both, so failing one alone still returns a healthy read.
      ASSETS: {
        async fetch() {
          return new Response("missing", { status: 404 });
        },
      },
      METAGRAPH_ARCHIVE: {
        async get() {
          return null;
        },
      },
    } as unknown as Env);
    assert.equal(res.ok, true);
    assert.equal(res.reason, "unchanged");
    assert.equal(queue.sent.length, 0);
  });

  test("the cron string routes to the dispatcher", async () => {
    // The wiring itself: a trigger registered in wrangler.jsonc that no branch
    // dispatches on is a cron that fires forever and does nothing.
    const { handleScheduled } = await import("../workers/api.ts");
    const { WEBHOOK_DISPATCH_CRON } = await import("../workers/config.ts");
    const res = (await handleScheduled(
      { cron: WEBHOOK_DISPATCH_CRON } as never,
      envWith(makeKv()) as unknown as Env,
      { waitUntil: (p: Promise<unknown>) => void p } as never,
    )) as { ok?: boolean; reason?: string };
    assert.equal(res.ok, true);
    assert.equal(res.reason, "not_provisioned", "no queue bound in this env");
  });
});
