import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildChangeEvent,
  deliverChangeEvent,
  deliveryStorageKey,
  dispatchChangeEvent,
  dispatchWithRedelivery,
  summarizeDeliveryRecords,
  WEBHOOK_DELIVERY_PREFIX,
  webhookEventId,
  webhookIdempotencyKey,
} from "../src/webhooks.mjs";

// In-memory stand-in for the METAGRAPH_CONTROL delivery namespace. Serializes on
// put / parses on get like the real KV-backed store the dispatcher injects.
function makeStore() {
  const map = new Map();
  return {
    map,
    async listKeys(prefix) {
      return [...map.keys()].filter((key) => key.startsWith(prefix));
    },
    async get(key) {
      return map.has(key) ? JSON.parse(map.get(key)) : null;
    },
    async put(key, value) {
      map.set(key, JSON.stringify(value));
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

const SUB = {
  id: "sub-7",
  url: "https://hooks.example.com/mg",
  secret: "a-sixteen-char!!",
  filters: { netuids: [7] },
};
// Matches SUB's filter (netuid 7); the "other" event does not (netuid 9), so it
// is filtered on the fresh path — isolating the redelivery as the only fetch.
const event7 = buildChangeEvent({
  changelog: { subnets: { added: [{ netuid: 7 }] } },
});
const event9 = buildChangeEvent({
  changelog: { subnets: { added: [{ netuid: 9 }] } },
});

const T0 = "2026-06-22T00:00:00.000Z";
const fail503 = async () => new Response("", { status: 503 });
const ok200 = async () => new Response("", { status: 200 });

// maxAttempts:1 keeps a transient failure synchronous (no backoff sleep).
const run = (overrides) =>
  dispatchWithRedelivery({
    subscriptions: [SUB],
    store,
    maxAttempts: 1,
    redeliveryBaseMs: 1000,
    redeliveryMaxMs: 60_000,
    maxRounds: 3,
    ...overrides,
  });

let store;
const keysOf = () => store.listKeys(WEBHOOK_DELIVERY_PREFIX);

// --- idempotency / event id helpers ------------------------------------------
describe("webhookEventId + webhookIdempotencyKey", () => {
  test("event id is a stable 32-hex digest of the content", async () => {
    const body = JSON.stringify(event7);
    const a = await webhookEventId(body);
    const b = await webhookEventId(body);
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{32}$/);
    assert.notEqual(a, await webhookEventId(JSON.stringify(event9)));
  });

  test("idempotency key folds in the subscription id and is stable", async () => {
    const body = JSON.stringify(event7);
    const a = await webhookIdempotencyKey("sub-7", body);
    assert.equal(a, await webhookIdempotencyKey("sub-7", body));
    assert.match(a, /^[0-9a-f]{64}$/);
    // Same content, different subscriber ⇒ different key.
    assert.notEqual(a, await webhookIdempotencyKey("sub-8", body));
  });
});

// --- deliverChangeEvent identity + retryability ------------------------------
describe("deliverChangeEvent at-least-once metadata", () => {
  test("emits the event-id + idempotency headers and returns the identity", async () => {
    let seen;
    const out = await deliverChangeEvent({
      subscription: SUB,
      event: event7,
      fetchFn: async (_url, init) => {
        seen = init.headers;
        return new Response("", { status: 200 });
      },
    });
    const body = JSON.stringify(event7);
    assert.equal(out.event_id, await webhookEventId(body));
    assert.equal(
      out.idempotency_key,
      await webhookIdempotencyKey(SUB.id, body),
    );
    assert.equal(seen["x-metagraph-event-id"], out.event_id);
    assert.equal(seen["x-metagraph-idempotency-key"], out.idempotency_key);
  });

  test("flags transient failures retryable, deterministic ones not", async () => {
    const transient = await deliverChangeEvent({
      subscription: SUB,
      event: event7,
      maxAttempts: 1,
      fetchFn: fail503,
    });
    assert.equal(transient.retryable, true);

    const deterministic = await deliverChangeEvent({
      subscription: SUB,
      event: event7,
      fetchFn: async () => new Response("", { status: 404 }),
    });
    assert.equal(deterministic.retryable, false);
  });

  test("a supplied bodyText is sent and signed verbatim", async () => {
    const stored = JSON.stringify(event7);
    let seenBody;
    const out = await deliverChangeEvent({
      // No filters: the provided bodyText, not the event object, is what ships.
      subscription: { id: SUB.id, url: SUB.url, secret: SUB.secret },
      event: { type: "ignored", change_kinds: [], affected_netuids: [] },
      bodyText: stored,
      fetchFn: async (_url, init) => {
        seenBody = init.body;
        return new Response("", { status: 200 });
      },
    });
    assert.equal(seenBody, stored);
    assert.equal(out.event_id, await webhookEventId(stored));
  });
});

// --- summarizeDeliveryRecords ------------------------------------------------
describe("summarizeDeliveryRecords", () => {
  const okSummary = {
    status: "ok",
    pending: 0,
    dead_letter: 0,
    last_failure: null,
  };

  test("no/empty/nullish records → ok", () => {
    assert.deepEqual(summarizeDeliveryRecords([]), okSummary);
    assert.deepEqual(summarizeDeliveryRecords(), okSummary);
    assert.deepEqual(summarizeDeliveryRecords(null), okSummary);
  });

  test("pending records (no dead letter) → retrying", () => {
    const summary = summarizeDeliveryRecords([
      {
        state: "pending",
        round: 2,
        reason: "timeout",
        last_attempt_at: "2026-06-22T00:00:00.000Z",
      },
    ]);
    assert.equal(summary.status, "retrying");
    assert.equal(summary.pending, 1);
    assert.equal(summary.last_failure.attempts, 2);
  });

  test("ignores malformed entries and reports the latest failure + dead count", () => {
    const summary = summarizeDeliveryRecords([
      null, // dropped by the object filter
      {
        state: "pending",
        round: 1,
        reason: "timeout",
        last_attempt_at: "2026-06-22T00:30:00.000Z",
      },
      {
        state: "dead",
        round: 8,
        reason: "http-503",
        status_code: 503,
        event_id: "deadbeef",
        last_attempt_at: "2026-06-22T01:00:00.000Z", // newest → latest
      },
      {
        state: "pending",
        round: 1,
        reason: "timeout",
        last_attempt_at: "2026-06-22T00:00:00.000Z", // older → does not win
      },
    ]);
    assert.equal(summary.status, "dead_letter");
    assert.equal(summary.pending, 2);
    assert.equal(summary.dead_letter, 1);
    assert.equal(summary.last_failure.event_id, "deadbeef");
    assert.equal(summary.last_failure.attempts, 8);
  });
});

// --- dispatchWithRedelivery: persistence + redelivery + dead-letter ----------
describe("dispatchWithRedelivery", () => {
  test("delivers a fresh event cleanly, writing nothing when nothing is parked", async () => {
    store = makeStore();
    const { delivered, redelivered } = await run({
      event: event7,
      now: () => T0,
      fetchFn: ok200,
    });
    assert.equal(delivered[0].status, "delivered");
    assert.deepEqual(redelivered, []);
    assert.deepEqual(await keysOf(), []); // no blind writes on the healthy path
  });

  test("parks a transient failure as a pending record", async () => {
    store = makeStore();
    const { delivered } = await run({
      event: event7,
      now: () => T0,
      fetchFn: fail503,
    });
    assert.equal(delivered[0].status, "failed");
    const keys = await keysOf();
    assert.equal(keys.length, 1);
    assert.equal(keys[0], deliveryStorageKey(SUB.id, delivered[0].event_id));
    const record = await store.get(keys[0]);
    assert.equal(record.state, "pending");
    assert.equal(record.round, 1);
    assert.equal(record.reason, "http-503");
    assert.equal(record.body, JSON.stringify(event7));
    assert.equal(record.next_attempt_at, "2026-06-22T00:00:01.000Z");
    assert.equal(record.first_failed_at, T0);
  });

  test("re-failing the same event in Phase 1 bumps the existing round", async () => {
    store = makeStore();
    await run({ event: event7, now: () => T0, fetchFn: fail503 }); // round 1
    // Same content republished and still failing → Phase 1 re-parks, not Phase 2.
    await run({
      event: event7,
      now: () => "2026-06-22T00:00:05.000Z",
      fetchFn: fail503,
    });
    const record = await store.get((await keysOf())[0]);
    assert.equal(record.round, 2);
    assert.equal(record.first_failed_at, T0); // preserved across rounds
  });

  test("does NOT park a deterministic 4xx failure", async () => {
    store = makeStore();
    const { delivered } = await run({
      event: event7,
      now: () => T0,
      fetchFn: async () => new Response("", { status: 404 }),
    });
    assert.equal(delivered[0].status, "failed");
    assert.equal(delivered[0].retryable, false);
    assert.deepEqual(await keysOf(), []);
  });

  test("redelivers a previously-failed event on a later run with the SAME idempotency key, then clears it", async () => {
    store = makeStore();
    let firstHeaders;
    await run({
      event: event7,
      now: () => T0,
      fetchFn: async (_url, init) => {
        firstHeaders = init.headers;
        return new Response("", { status: 503 });
      },
    });
    assert.equal((await keysOf()).length, 1);

    // A later publish (event9 — filtered out for this subscriber) past the
    // schedule: only the parked event7 is (re)delivered, and it succeeds.
    let secondHeaders;
    let secondBody;
    const { redelivered } = await run({
      event: event9,
      now: () => "2026-06-22T00:00:05.000Z",
      fetchFn: async (_url, init) => {
        secondHeaders = init.headers;
        secondBody = init.body;
        return new Response("", { status: 200 });
      },
    });
    assert.equal(redelivered.length, 1);
    assert.equal(redelivered[0].status, "delivered");
    // The original event bytes are re-sent — not the new event9.
    assert.equal(secondBody, JSON.stringify(event7));
    // Idempotency + event id are identical across the failure and the redelivery.
    assert.equal(
      secondHeaders["x-metagraph-idempotency-key"],
      firstHeaders["x-metagraph-idempotency-key"],
    );
    assert.equal(
      secondHeaders["x-metagraph-event-id"],
      firstHeaders["x-metagraph-event-id"],
    );
    // Successful redelivery clears the parked record.
    assert.deepEqual(await keysOf(), []);
  });

  test("respects the schedule — a not-yet-due record is left untouched", async () => {
    store = makeStore();
    await run({ event: event7, now: () => T0, fetchFn: fail503 });
    const { redelivered } = await run({
      event: event9, // filtered for this sub → no fresh fetch
      now: () => "2026-06-22T00:00:00.500Z", // before next_attempt_at (+1s)
      fetchFn: ok200,
    });
    assert.equal(redelivered.length, 0);
    assert.equal((await keysOf()).length, 1); // still pending
  });

  test("dead-letters after the round cap is hit", async () => {
    store = makeStore();
    await run({
      event: event7,
      now: () => T0,
      maxRounds: 2,
      fetchFn: fail503,
    }); // round 1
    const { redelivered } = await run({
      event: event9,
      now: () => "2026-06-22T00:00:05.000Z",
      maxRounds: 2,
      fetchFn: fail503,
    }); // round 2 == cap → dead
    assert.equal(redelivered[0].status, "failed");
    const record = await store.get((await keysOf())[0]);
    assert.equal(record.state, "dead");
    assert.equal(record.round, 2);
    assert.equal(record.next_attempt_at, null);

    // A dead letter is never re-attempted again.
    const after = await run({
      event: event9,
      now: () => "2026-06-22T01:00:00.000Z",
      maxRounds: 2,
      fetchFn: fail503,
    });
    assert.equal(after.redelivered.length, 0);
  });

  test("a deterministic failure during redelivery dead-letters immediately", async () => {
    store = makeStore();
    await run({ event: event7, now: () => T0, fetchFn: fail503 }); // round 1, pending
    await run({
      event: event9,
      now: () => "2026-06-22T00:00:05.000Z",
      fetchFn: async () => new Response("", { status: 410 }),
    });
    const record = await store.get((await keysOf())[0]);
    assert.equal(record.state, "dead");
    assert.equal(record.round, 2); // < cap (3), but deterministic → dead
  });

  test("a successful fresh delivery clears a prior park for the same event", async () => {
    store = makeStore();
    await run({ event: event7, now: () => T0, fetchFn: fail503 });
    assert.equal((await keysOf()).length, 1);
    // Same event content republished, endpoint now healthy.
    const { delivered, redelivered } = await run({
      event: event7,
      now: () => "2026-06-22T00:00:05.000Z",
      fetchFn: ok200,
    });
    assert.equal(delivered[0].status, "delivered");
    assert.equal(redelivered.length, 0); // Phase 1 already cleared it
    assert.deepEqual(await keysOf(), []);
  });

  test("skips redelivery when the subscription is gone (record left for TTL)", async () => {
    store = makeStore();
    await run({ event: event7, now: () => T0, fetchFn: fail503 });
    const { redelivered } = await dispatchWithRedelivery({
      subscriptions: [], // subscription deleted/expired
      store,
      event: event9,
      now: () => "2026-06-22T00:00:05.000Z",
      maxAttempts: 1,
      redeliveryBaseMs: 1000,
      fetchFn: ok200,
    });
    assert.equal(redelivered.length, 0);
    assert.equal((await keysOf()).length, 1); // untouched
  });

  test("redelivery sweep honors list, run, and per-subscription budgets", async () => {
    store = makeStore();
    const sub8 = { ...SUB, id: "sub-8", filters: { netuids: [9] } };
    for (let i = 0; i < 6; i += 1) {
      const subscriptionId = i < 4 ? SUB.id : sub8.id;
      const dueBody = JSON.stringify(
        subscriptionId === SUB.id ? event7 : event9,
      );
      store.map.set(
        deliveryStorageKey(subscriptionId, `event-${i}`),
        JSON.stringify({
          subscription_id: subscriptionId,
          event_id: `event-${i}`,
          body: dueBody,
          state: "pending",
          round: 1,
          next_attempt_at: T0,
        }),
      );
    }

    let attempts = 0;
    const { redelivered } = await dispatchWithRedelivery({
      subscriptions: [SUB, sub8],
      store,
      event: buildChangeEvent({
        changelog: { artifacts: { added: ["meta"] } },
      }),
      now: () => "2026-06-22T00:00:05.000Z",
      maxAttempts: 1,
      redeliveryListLimit: 5,
      maxRedeliveriesPerRun: 3,
      maxRedeliveriesPerSubscription: 2,
      fetchFn: async () => {
        attempts += 1;
        return new Response("", { status: 200 });
      },
    });

    assert.equal(redelivered.length, 3);
    assert.equal(attempts, 3);
    assert.deepEqual(
      redelivered.map((result) => result.id),
      [SUB.id, SUB.id, sub8.id],
    );
  });

  test("a redelivery get failure skips that record without crashing", async () => {
    // The store lists a parked key but its get throws → the record is treated as
    // absent and the sweep moves on, rather than rejecting the whole dispatch.
    const flaky = {
      async listKeys() {
        return [deliveryStorageKey(SUB.id, "ev")];
      },
      async get() {
        throw new Error("kv get down");
      },
      async put() {},
      async delete() {},
    };
    const { redelivered } = await dispatchWithRedelivery({
      subscriptions: [SUB],
      store: flaky,
      event: event9, // filtered for SUB → no fresh fetch
      now: () => T0,
      maxAttempts: 1,
      fetchFn: ok200,
    });
    assert.deepEqual(redelivered, []);
  });

  test("a throwing control store never sinks the dispatch", async () => {
    const brokenStore = {
      async listKeys() {
        throw new Error("kv list down");
      },
      async get() {
        throw new Error("kv get down");
      },
      async put() {
        throw new Error("kv put down");
      },
      async delete() {
        throw new Error("kv delete down");
      },
    };
    const { delivered, redelivered } = await dispatchWithRedelivery({
      subscriptions: [SUB],
      store: brokenStore,
      event: event7,
      now: () => T0,
      maxAttempts: 1,
      fetchFn: fail503,
    });
    assert.equal(delivered[0].status, "failed");
    assert.deepEqual(redelivered, []);
  });

  test("parks a network error with a null status_code", async () => {
    store = makeStore();
    const { delivered } = await run({
      event: event7,
      now: () => T0,
      fetchFn: async () => {
        throw new Error("connection reset");
      },
    });
    assert.equal(delivered[0].status, "failed");
    assert.equal(delivered[0].reason, "network-error");
    const record = await store.get((await keysOf())[0]);
    assert.equal(record.reason, "network-error");
    assert.equal(record.status_code, null);
  });

  test("redelivery tolerates a corrupt stored body (drops it)", async () => {
    store = makeStore();
    store.map.set(
      deliveryStorageKey(SUB.id, "corrupt-event"),
      JSON.stringify({
        subscription_id: SUB.id,
        event_id: "corrupt-event",
        body: "{not json",
        state: "pending",
        round: 1,
        next_attempt_at: T0,
      }),
    );
    const { redelivered } = await run({
      event: event9, // filtered for SUB → no fresh fetch
      now: () => "2026-06-22T00:00:05.000Z",
      fetchFn: ok200,
    });
    // Unparseable body → no event to match → dropped, not retried forever.
    assert.equal(redelivered[0].status, "filtered");
    assert.deepEqual(await keysOf(), []);
  });

  test("with no store: delivers but neither parks nor redelivers", async () => {
    const { delivered, redelivered } = await dispatchWithRedelivery({
      subscriptions: [SUB],
      event: event7,
      now: () => T0,
      maxAttempts: 1,
      fetchFn: fail503,
    });
    assert.equal(delivered[0].status, "failed");
    assert.deepEqual(redelivered, []);
  });

  test("no subscriptions and no clock → empty, epoch-safe", async () => {
    store = makeStore();
    const { delivered, redelivered } = await dispatchWithRedelivery({
      store,
      event: event7,
      fetchFn: ok200,
    });
    assert.deepEqual(delivered, []);
    assert.deepEqual(redelivered, []);
  });

  test("dispatchChangeEvent with no subscriptions → empty", async () => {
    assert.deepEqual(
      await dispatchChangeEvent({ event: event7, fetchFn: ok200 }),
      [],
    );
  });
});
