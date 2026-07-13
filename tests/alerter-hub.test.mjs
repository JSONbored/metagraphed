// Unit tests for workers/alerter-hub.mjs (#4984 Parts 2+3). No Durable
// Object runtime needed -- state.storage is never touched by this class
// (the trigger cache is plain in-memory instance state, refreshed from
// env.DATA_API), so it's fully Node-testable like McpSessionHub.
import assert from "node:assert/strict";
import { test, vi } from "vitest";
import {
  ALERTER_HUB_TRIGGER_CACHE_TTL_MS,
  AlerterHub,
  deliverAlertMatch,
} from "../workers/alerter-hub.mjs";

const INTERNAL_TOKEN = "test-internal-token";

function fakeDataApi(handler) {
  return { fetch: handler };
}

function triggerRow(overrides = {}) {
  return {
    id: "1",
    tableFilter: null,
    netuid: 7,
    eventKind: null,
    account: null,
    minAmountTao: null,
    channel: "email",
    destination: "a@b.com",
    ...overrides,
  };
}

test("ALERTER_HUB_TRIGGER_CACHE_TTL_MS is the documented value (5 minutes)", () => {
  assert.equal(ALERTER_HUB_TRIGGER_CACHE_TTL_MS, 5 * 60 * 1000);
});

// --- deliverAlertMatch (#4984 Part 3) -----------------------------------------

test("deliverAlertMatch: webhook channel POSTs the built request", async () => {
  let received;
  const fetchFn = vi.fn(async (url, init) => {
    received = { url, init };
    return new Response(null, { status: 200 });
  });
  await deliverAlertMatch(
    triggerRow({ channel: "webhook", destination: "https://example.com/hook" }),
    { table: "account_events" },
    {},
    fetchFn,
  );
  assert.equal(fetchFn.mock.calls.length, 1);
  assert.equal(received.url, "https://example.com/hook");
  assert.equal(JSON.parse(received.init.body).type, "metagraph.alert");
});

test("deliverAlertMatch: every delivery carries a bounded AbortSignal so one slow target can't stall the shared broadcast() call indefinitely", async () => {
  let receivedSignal;
  const fetchFn = vi.fn(async (_url, init) => {
    receivedSignal = init.signal;
    return new Response(null, { status: 200 });
  });
  await deliverAlertMatch(
    triggerRow({
      channel: "webhook",
      destination: "https://example.com/hook",
    }),
    {},
    {},
    fetchFn,
  );
  assert.ok(receivedSignal instanceof AbortSignal);
  assert.equal(receivedSignal.aborted, false);
});

test("deliverAlertMatch: webhook channel sends nothing when the destination fails the defense-in-depth URL re-check", async () => {
  const fetchFn = vi.fn();
  await deliverAlertMatch(
    triggerRow({
      channel: "webhook",
      destination: "http://not-https.example.com",
    }),
    {},
    {},
    fetchFn,
  );
  assert.equal(fetchFn.mock.calls.length, 0);
});

test("deliverAlertMatch: discord channel POSTs to the trigger's own webhook URL", async () => {
  const fetchFn = vi.fn(async () => new Response(null, { status: 204 }));
  await deliverAlertMatch(
    triggerRow({
      channel: "discord",
      destination: "https://discord.com/api/webhooks/1/token",
    }),
    { table: "account_events" },
    {},
    fetchFn,
  );
  assert.equal(
    fetchFn.mock.calls[0][0],
    "https://discord.com/api/webhooks/1/token",
  );
});

test("deliverAlertMatch: telegram channel is a silent no-op when TELEGRAM_BOT_TOKEN is unset", async () => {
  const fetchFn = vi.fn();
  await deliverAlertMatch(
    triggerRow({ channel: "telegram", destination: "123456789" }),
    {},
    {},
    fetchFn,
  );
  assert.equal(fetchFn.mock.calls.length, 0);
});

test("deliverAlertMatch: telegram channel POSTs to the bot API when the token is configured", async () => {
  const fetchFn = vi.fn(async () => new Response(null, { status: 200 }));
  await deliverAlertMatch(
    triggerRow({ channel: "telegram", destination: "123456789" }),
    {},
    { TELEGRAM_BOT_TOKEN: "bot-token" },
    fetchFn,
  );
  assert.equal(
    fetchFn.mock.calls[0][0],
    "https://api.telegram.org/botbot-token/sendMessage",
  );
});

test("deliverAlertMatch: email channel is a silent no-op when RESEND_API_KEY or RESEND_FROM_ADDRESS is unset", async () => {
  const fetchFn = vi.fn();
  await deliverAlertMatch(triggerRow({ channel: "email" }), {}, {}, fetchFn);
  assert.equal(fetchFn.mock.calls.length, 0);
  await deliverAlertMatch(
    triggerRow({ channel: "email" }),
    {},
    { RESEND_API_KEY: "k" }, // no from-address
    fetchFn,
  );
  assert.equal(fetchFn.mock.calls.length, 0);
});

test("deliverAlertMatch: email channel POSTs to Resend when both secrets are configured", async () => {
  const fetchFn = vi.fn(async () => new Response(null, { status: 200 }));
  await deliverAlertMatch(
    triggerRow({ channel: "email", destination: "a@b.com" }),
    {},
    { RESEND_API_KEY: "k", RESEND_FROM_ADDRESS: "alerts@metagraph.sh" },
    fetchFn,
  );
  assert.equal(fetchFn.mock.calls[0][0], "https://api.resend.com/emails");
});

test("deliverAlertMatch: an unrecognized channel is a silent no-op", async () => {
  const fetchFn = vi.fn();
  await deliverAlertMatch(
    triggerRow({ channel: "carrier-pigeon" }),
    {},
    {},
    fetchFn,
  );
  assert.equal(fetchFn.mock.calls.length, 0);
});

test("deliverAlertMatch: a non-ok HTTP response is logged, not thrown", async () => {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const fetchFn = vi.fn(async () => new Response(null, { status: 500 }));
  await assert.doesNotReject(() =>
    deliverAlertMatch(
      triggerRow({
        channel: "discord",
        destination: "https://discord.com/api/webhooks/1/t",
      }),
      {},
      {},
      fetchFn,
    ),
  );
  assert.equal(errorSpy.mock.calls.length, 1);
  assert.match(errorSpy.mock.calls[0][0], /HTTP 500/);
  errorSpy.mockRestore();
});

test("deliverAlertMatch: defaults fetchFn to the global fetch when not injected", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response(null, { status: 200 });
  };
  try {
    await deliverAlertMatch(
      triggerRow({
        channel: "discord",
        destination: "https://discord.com/api/webhooks/1/t",
      }),
      {},
      {},
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(called, true);
});

// --- isTriggerCacheStale / refreshTriggers -----------------------------------

test("isTriggerCacheStale: true before any load, false immediately after a successful refresh", async () => {
  const hub = new AlerterHub(
    {},
    {
      DATA_API: fakeDataApi(
        async () =>
          new Response(JSON.stringify({ triggers: [] }), { status: 200 }),
      ),
      ALERT_TRIGGERS_INTERNAL_TOKEN: INTERNAL_TOKEN,
    },
  );
  assert.equal(hub.isTriggerCacheStale(), true);
  await hub.refreshTriggers();
  assert.equal(hub.isTriggerCacheStale(), false);
});

test("refreshTriggers: a no-op when DATA_API is unbound", async () => {
  const hub = new AlerterHub(
    {},
    { ALERT_TRIGGERS_INTERNAL_TOKEN: INTERNAL_TOKEN },
  );
  await hub.refreshTriggers();
  assert.deepEqual(hub.triggers, []);
  assert.equal(hub.triggersLoadedAt, 0);
});

test("refreshTriggers: a no-op when ALERT_TRIGGERS_INTERNAL_TOKEN is unset", async () => {
  let called = false;
  const hub = new AlerterHub(
    {},
    {
      DATA_API: fakeDataApi(async () => {
        called = true;
        return new Response(JSON.stringify({ triggers: [] }), { status: 200 });
      }),
    },
  );
  await hub.refreshTriggers();
  assert.equal(called, false);
  assert.deepEqual(hub.triggers, []);
});

test("refreshTriggers: fetches the internal active-list route with the correct URL and header", async () => {
  let receivedUrl;
  let receivedToken;
  const hub = new AlerterHub(
    {},
    {
      DATA_API: fakeDataApi(async (url, init) => {
        receivedUrl = String(url);
        receivedToken = init.headers["x-alert-triggers-internal-token"];
        return new Response(JSON.stringify({ triggers: [triggerRow()] }), {
          status: 200,
        });
      }),
      ALERT_TRIGGERS_INTERNAL_TOKEN: INTERNAL_TOKEN,
    },
  );
  await hub.refreshTriggers();
  assert.equal(
    receivedUrl,
    "https://data-api.internal/api/v1/internal/alert-triggers-active",
  );
  assert.equal(receivedToken, INTERNAL_TOKEN);
  assert.equal(hub.triggers.length, 1);
  assert.notEqual(hub.triggersLoadedAt, 0);
});

test("refreshTriggers: the DATA_API fetch carries a bounded AbortSignal so a slow Postgres query can't stall ChainFirehoseHub's own broadcast()-wide wait", async () => {
  let receivedSignal;
  const hub = new AlerterHub(
    {},
    {
      DATA_API: fakeDataApi(async (_url, init) => {
        receivedSignal = init.signal;
        return new Response(JSON.stringify({ triggers: [] }), { status: 200 });
      }),
      ALERT_TRIGGERS_INTERNAL_TOKEN: INTERNAL_TOKEN,
    },
  );
  await hub.refreshTriggers();
  assert.ok(receivedSignal instanceof AbortSignal);
  assert.equal(receivedSignal.aborted, false);
});

test("refreshTriggers: keeps the stale cache when the upstream response is not ok", async () => {
  const hub = new AlerterHub(
    {},
    {
      DATA_API: fakeDataApi(
        async () =>
          new Response(JSON.stringify({ error: "nope" }), { status: 500 }),
      ),
      ALERT_TRIGGERS_INTERNAL_TOKEN: INTERNAL_TOKEN,
    },
  );
  hub.triggers = [triggerRow({ id: "existing" })];
  await hub.refreshTriggers();
  assert.equal(hub.triggers[0].id, "existing");
  assert.equal(hub.triggersLoadedAt, 0);
});

test("refreshTriggers: keeps the stale cache when the body's triggers field isn't an array", async () => {
  const hub = new AlerterHub(
    {},
    {
      DATA_API: fakeDataApi(
        async () =>
          new Response(JSON.stringify({ triggers: "not-an-array" }), {
            status: 200,
          }),
      ),
      ALERT_TRIGGERS_INTERNAL_TOKEN: INTERNAL_TOKEN,
    },
  );
  hub.triggers = [triggerRow({ id: "existing" })];
  await hub.refreshTriggers();
  assert.equal(hub.triggers[0].id, "existing");
});

test("refreshTriggers: keeps the stale cache and never throws when the fetch itself rejects", async () => {
  const hub = new AlerterHub(
    {},
    {
      DATA_API: fakeDataApi(async () => {
        throw new Error("network down");
      }),
      ALERT_TRIGGERS_INTERNAL_TOKEN: INTERNAL_TOKEN,
    },
  );
  hub.triggers = [triggerRow({ id: "existing" })];
  await assert.doesNotReject(() => hub.refreshTriggers());
  assert.equal(hub.triggers[0].id, "existing");
});

test("refreshTriggers: keeps the stale cache and never throws when upstream.json() itself throws", async () => {
  const hub = new AlerterHub(
    {},
    {
      DATA_API: fakeDataApi(
        async () => new Response("not json", { status: 200 }),
      ),
      ALERT_TRIGGERS_INTERNAL_TOKEN: INTERNAL_TOKEN,
    },
  );
  hub.triggers = [triggerRow({ id: "existing" })];
  await assert.doesNotReject(() => hub.refreshTriggers());
  assert.equal(hub.triggers[0].id, "existing");
});

// --- ensureTriggersLoaded -----------------------------------------------------

test("ensureTriggersLoaded: refreshes when the cache is stale", async () => {
  let calls = 0;
  const hub = new AlerterHub(
    {},
    {
      DATA_API: fakeDataApi(async () => {
        calls += 1;
        return new Response(JSON.stringify({ triggers: [] }), { status: 200 });
      }),
      ALERT_TRIGGERS_INTERNAL_TOKEN: INTERNAL_TOKEN,
    },
  );
  await hub.ensureTriggersLoaded();
  assert.equal(calls, 1);
});

test("ensureTriggersLoaded: skips the refresh entirely once the cache is fresh", async () => {
  let calls = 0;
  const hub = new AlerterHub(
    {},
    {
      DATA_API: fakeDataApi(async () => {
        calls += 1;
        return new Response(JSON.stringify({ triggers: [] }), { status: 200 });
      }),
      ALERT_TRIGGERS_INTERNAL_TOKEN: INTERNAL_TOKEN,
    },
  );
  await hub.ensureTriggersLoaded();
  await hub.ensureTriggersLoaded();
  assert.equal(calls, 1);
});

test("ensureTriggersLoaded: coalesces concurrent stale-cache calls into ONE refresh", async () => {
  let calls = 0;
  let resolveFetch;
  const hub = new AlerterHub(
    {},
    {
      DATA_API: fakeDataApi(
        () =>
          new Promise((resolve) => {
            calls += 1;
            resolveFetch = () =>
              resolve(
                new Response(JSON.stringify({ triggers: [] }), {
                  status: 200,
                }),
              );
          }),
      ),
      ALERT_TRIGGERS_INTERNAL_TOKEN: INTERNAL_TOKEN,
    },
  );
  const first = hub.ensureTriggersLoaded();
  const second = hub.ensureTriggersLoaded();
  resolveFetch();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
});

// --- matchingTriggers / evaluate -----------------------------------------------

test("matchingTriggers: filters the cache via triggerMatchesEvent", () => {
  const hub = new AlerterHub({}, {});
  hub.triggers = [
    triggerRow({ id: "1", netuid: 7 }),
    triggerRow({ id: "2", netuid: 8 }),
  ];
  const matches = hub.matchingTriggers({ table: "account_events", netuid: 7 });
  assert.deepEqual(
    matches.map((t) => t.id),
    ["1"],
  );
});

test("evaluate: returns {matched:0} and never calls deliver when nothing matches", async () => {
  const deliver = vi.fn();
  const hub = new AlerterHub({}, {}, { deliver });
  hub.triggers = [triggerRow({ netuid: 7 })];
  hub.triggersLoadedAt = Date.now(); // fresh -- skip the refresh path
  const result = await hub.evaluate({ table: "account_events", netuid: 99 });
  assert.deepEqual(result, { matched: 0 });
  assert.equal(deliver.mock.calls.length, 0);
});

test("evaluate: reports every matching trigger and calls deliver once per match", async () => {
  const deliver = vi.fn().mockResolvedValue(undefined);
  const hub = new AlerterHub({}, {}, { deliver });
  hub.triggers = [
    triggerRow({ id: "1", netuid: 7 }),
    triggerRow({ id: "2", netuid: 7 }),
    triggerRow({ id: "3", netuid: 8 }),
  ];
  hub.triggersLoadedAt = Date.now();
  const payload = { table: "account_events", netuid: 7 };
  const result = await hub.evaluate(payload);
  assert.equal(result.matched, 2);
  assert.deepEqual(result.trigger_ids.sort(), ["1", "2"]);
  assert.equal(result.delivered, 2);
  assert.equal(result.rate_limited, 0);
  assert.equal(deliver.mock.calls.length, 2);
  assert.equal(deliver.mock.calls[0][1], payload);
});

test("evaluate: a burst of matches for the SAME trigger within the rate-limit window delivers once and skips the rest", async () => {
  const deliver = vi.fn().mockResolvedValue(undefined);
  const hub = new AlerterHub({}, {}, { deliver });
  hub.triggers = [triggerRow({ netuid: 7 })];
  hub.triggersLoadedAt = Date.now();
  const payload = { table: "account_events", netuid: 7 };

  const first = await hub.evaluate(payload);
  assert.equal(first.delivered, 1);
  assert.equal(first.rate_limited, 0);

  const second = await hub.evaluate(payload);
  assert.equal(second.matched, 1); // still reported as a real match...
  assert.equal(second.delivered, 0); // ...but not delivered again this soon
  assert.equal(second.rate_limited, 1);

  assert.equal(deliver.mock.calls.length, 1);
});

test("evaluate: a DIFFERENT trigger's match is never rate-limited by another trigger's recent delivery", async () => {
  const deliver = vi.fn().mockResolvedValue(undefined);
  const hub = new AlerterHub({}, {}, { deliver });
  hub.triggers = [
    triggerRow({ id: "1", netuid: 7 }),
    triggerRow({ id: "2", netuid: 7 }),
  ];
  hub.triggersLoadedAt = Date.now();
  const payload = { table: "account_events", netuid: 7 };

  await hub.evaluate(payload); // delivers both "1" and "2" once
  hub.lastDeliveredAt.delete("2"); // simulate "2" being outside its own window already
  const second = await hub.evaluate(payload);
  assert.equal(second.delivered, 1); // only "2" delivers again
  assert.equal(second.rate_limited, 1); // "1" is still within its window
});

test("evaluate: once the rate-limit window elapses, the same trigger can deliver again", async () => {
  const deliver = vi.fn().mockResolvedValue(undefined);
  const hub = new AlerterHub({}, {}, { deliver });
  hub.triggers = [triggerRow({ id: "1", netuid: 7 })];
  hub.triggersLoadedAt = Date.now();
  const payload = { table: "account_events", netuid: 7 };

  await hub.evaluate(payload);
  // Simulate the window having elapsed rather than waiting on a real clock.
  hub.lastDeliveredAt.set("1", Date.now() - 10 * 60 * 1000);
  const result = await hub.evaluate(payload);
  assert.equal(result.delivered, 1);
  assert.equal(result.rate_limited, 0);
  assert.equal(deliver.mock.calls.length, 2);
});

test("evaluate: a rejecting deliver call never fails the overall evaluation", async () => {
  const deliver = vi.fn().mockRejectedValue(new Error("delivery exploded"));
  const hub = new AlerterHub({}, {}, { deliver });
  hub.triggers = [triggerRow({ netuid: 7 })];
  hub.triggersLoadedAt = Date.now();
  const result = await hub.evaluate({ table: "account_events", netuid: 7 });
  assert.equal(result.matched, 1);
});

test("evaluate: caps the delivery fan-out at ALERT_DELIVERY_CONCURRENCY (8) in-flight deliveries -- a broad-condition trigger set matching MANY distinct triggers on one event must not open one outbound fetch per match", async () => {
  const TRIGGER_COUNT = 20;
  let inFlight = 0;
  let maxInFlight = 0;
  const resolvers = [];
  const deliver = vi.fn(
    () =>
      new Promise((resolve) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        resolvers.push(() => {
          inFlight -= 1;
          resolve();
        });
      }),
  );
  const hub = new AlerterHub({}, {}, { deliver });
  hub.triggers = Array.from({ length: TRIGGER_COUNT }, (_, i) =>
    triggerRow({ id: String(i), netuid: 7 }),
  );
  hub.triggersLoadedAt = Date.now();

  const evaluatePromise = hub.evaluate({ table: "account_events", netuid: 7 });
  // Let every microtask-queued deliver() call actually start.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(inFlight, 8);
  assert.equal(maxInFlight, 8);

  // Drain in waves of 8, confirming the cap holds throughout, not just at
  // the start.
  while (resolvers.length > 0) {
    const wave = resolvers.splice(0, resolvers.length);
    wave.forEach((r) => r());
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(inFlight <= 8);
  }

  const result = await evaluatePromise;
  assert.equal(result.delivered, TRIGGER_COUNT);
  assert.equal(deliver.mock.calls.length, TRIGGER_COUNT);
  assert.equal(maxInFlight, 8);
});

test("evaluate: triggers a refresh first when the cache is stale", async () => {
  let refreshed = false;
  const hub = new AlerterHub(
    {},
    {
      DATA_API: fakeDataApi(async () => {
        refreshed = true;
        return new Response(
          JSON.stringify({ triggers: [triggerRow({ netuid: 7 })] }),
          { status: 200 },
        );
      }),
      ALERT_TRIGGERS_INTERNAL_TOKEN: INTERNAL_TOKEN,
    },
  );
  const result = await hub.evaluate({ table: "account_events", netuid: 7 });
  assert.equal(refreshed, true);
  assert.equal(result.matched, 1);
});

// --- fetch (the /evaluate route) -----------------------------------------------

test("fetch: POST /evaluate with a valid JSON body returns the evaluate() result", async () => {
  const hub = new AlerterHub({}, {});
  hub.triggers = [triggerRow({ netuid: 7 })];
  hub.triggersLoadedAt = Date.now();
  const res = await hub.fetch(
    new Request("https://alerter-hub.internal/evaluate", {
      method: "POST",
      body: JSON.stringify({ table: "account_events", netuid: 7 }),
    }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    matched: 1,
    trigger_ids: [triggerRow().id],
    delivered: 1,
    rate_limited: 0,
  });
});

test("fetch: POST /evaluate with malformed JSON returns 400", async () => {
  const hub = new AlerterHub({}, {});
  const res = await hub.fetch(
    new Request("https://alerter-hub.internal/evaluate", {
      method: "POST",
      body: "not json",
    }),
  );
  assert.equal(res.status, 400);
});

test("fetch: an unrecognized path 404s", async () => {
  const hub = new AlerterHub({}, {});
  const res = await hub.fetch(new Request("https://alerter-hub.internal/nope"));
  assert.equal(res.status, 404);
});

test("fetch: GET /evaluate (wrong method) 404s", async () => {
  const hub = new AlerterHub({}, {});
  const res = await hub.fetch(
    new Request("https://alerter-hub.internal/evaluate"),
  );
  assert.equal(res.status, 404);
});
