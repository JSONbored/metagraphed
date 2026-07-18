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

test("deliverAlertMatch: webhook channel POSTs the built request and resolves true on a confirmed 2xx", async () => {
  let received;
  const fetchFn = vi.fn(async (url, init) => {
    received = { url, init };
    return new Response(null, { status: 200 });
  });
  const result = await deliverAlertMatch(
    triggerRow({ channel: "webhook", destination: "https://example.com/hook" }),
    { table: "account_events" },
    {},
    fetchFn,
    { resolveHostnames: async () => ["93.184.216.34"] },
  );
  assert.equal(fetchFn.mock.calls.length, 1);
  assert.equal(received.url, "https://example.com/hook");
  assert.equal(JSON.parse(received.init.body).type, "metagraph.alert");
  assert.equal(result, true);
});

test("deliverAlertMatch: falls back to the real DoH resolver when no resolveHostnames is injected", async () => {
  const fetchFn = vi.fn(async (url) => {
    const target = new URL(String(url));
    if (target.hostname === "cloudflare-dns.com") {
      const type = target.searchParams.get("type");
      const data =
        type === "A" ? "93.184.216.34" : "2606:2800:220:1:248:1893:25c8:1946";
      return new Response(JSON.stringify({ Answer: [{ data }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(null, { status: 200 });
  });
  const result = await deliverAlertMatch(
    triggerRow({ channel: "webhook", destination: "https://example.com/hook" }),
    { table: "account_events" },
    {},
    fetchFn,
  );
  assert.equal(result, true);
  const deliveryCall = fetchFn.mock.calls.find(
    ([url]) => String(url) === "https://example.com/hook",
  );
  assert.ok(deliveryCall, "the actual webhook delivery request was sent");
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
    { resolveHostnames: async () => ["93.184.216.34"] },
  );
  assert.ok(receivedSignal instanceof AbortSignal);
  assert.equal(receivedSignal.aborted, false);
});

test("deliverAlertMatch: webhook delivery uses manual redirects", async () => {
  let receivedInit;
  const fetchFn = vi.fn(async (_url, init) => {
    receivedInit = init;
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
    { resolveHostnames: async () => ["93.184.216.34"] },
  );
  assert.equal(receivedInit.redirect, "manual");
});

test("deliverAlertMatch: webhook channel sends nothing and resolves false when DNS resolves private", async () => {
  const fetchFn = vi.fn();
  const result = await deliverAlertMatch(
    triggerRow({
      channel: "webhook",
      destination: "https://example.com/hook",
    }),
    {},
    {},
    fetchFn,
    { resolveHostnames: async () => ["10.0.0.1"] },
  );
  assert.equal(fetchFn.mock.calls.length, 0);
  assert.equal(result, false);
});

test("deliverAlertMatch: webhook channel sends nothing and resolves false when the destination fails the defense-in-depth URL re-check", async () => {
  const fetchFn = vi.fn();
  const result = await deliverAlertMatch(
    triggerRow({
      channel: "webhook",
      destination: "http://not-https.example.com",
    }),
    {},
    {},
    fetchFn,
  );
  assert.equal(fetchFn.mock.calls.length, 0);
  assert.equal(result, false);
});

test("deliverAlertMatch: discord channel POSTs to the trigger's own webhook URL and resolves true on a confirmed 2xx", async () => {
  const fetchFn = vi.fn(async () => new Response(null, { status: 204 }));
  const result = await deliverAlertMatch(
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
  assert.equal(result, true);
});

test("deliverAlertMatch: telegram channel is a silent no-op (resolves false) when TELEGRAM_BOT_TOKEN is unset", async () => {
  const fetchFn = vi.fn();
  const result = await deliverAlertMatch(
    triggerRow({ channel: "telegram", destination: "123456789" }),
    {},
    {},
    fetchFn,
  );
  assert.equal(fetchFn.mock.calls.length, 0);
  assert.equal(result, false);
});

test("deliverAlertMatch: telegram channel POSTs to the bot API and resolves true when the token is configured", async () => {
  const fetchFn = vi.fn(async () => new Response(null, { status: 200 }));
  const result = await deliverAlertMatch(
    triggerRow({ channel: "telegram", destination: "123456789" }),
    {},
    { TELEGRAM_BOT_TOKEN: "bot-token" },
    fetchFn,
  );
  assert.equal(
    fetchFn.mock.calls[0][0],
    "https://api.telegram.org/botbot-token/sendMessage",
  );
  assert.equal(result, true);
});

test("deliverAlertMatch: email channel is a silent no-op (resolves false) when RESEND_API_KEY or RESEND_FROM_ADDRESS is unset", async () => {
  const fetchFn = vi.fn();
  const first = await deliverAlertMatch(
    triggerRow({ channel: "email" }),
    {},
    {},
    fetchFn,
  );
  assert.equal(fetchFn.mock.calls.length, 0);
  assert.equal(first, false);
  const second = await deliverAlertMatch(
    triggerRow({ channel: "email" }),
    {},
    { RESEND_API_KEY: "k" }, // no from-address
    fetchFn,
  );
  assert.equal(fetchFn.mock.calls.length, 0);
  assert.equal(second, false);
});

test("deliverAlertMatch: email channel POSTs to Resend and resolves true when both secrets are configured", async () => {
  const fetchFn = vi.fn(async () => new Response(null, { status: 200 }));
  const result = await deliverAlertMatch(
    triggerRow({ channel: "email", destination: "a@b.com" }),
    {},
    { RESEND_API_KEY: "k", RESEND_FROM_ADDRESS: "alerts@metagraph.sh" },
    fetchFn,
  );
  assert.equal(fetchFn.mock.calls[0][0], "https://api.resend.com/emails");
  assert.equal(result, true);
});

test("deliverAlertMatch: an unrecognized channel is a silent no-op (resolves false)", async () => {
  const fetchFn = vi.fn();
  const result = await deliverAlertMatch(
    triggerRow({ channel: "carrier-pigeon" }),
    {},
    {},
    fetchFn,
  );
  assert.equal(fetchFn.mock.calls.length, 0);
  assert.equal(result, false);
});

test("deliverAlertMatch: a non-ok HTTP response is logged, not thrown, and resolves false", async () => {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const fetchFn = vi.fn(async () => new Response(null, { status: 500 }));
  let result;
  await assert.doesNotReject(async () => {
    result = await deliverAlertMatch(
      triggerRow({
        channel: "discord",
        destination: "https://discord.com/api/webhooks/1/t",
      }),
      {},
      {},
      fetchFn,
    );
  });
  assert.equal(errorSpy.mock.calls.length, 1);
  assert.match(errorSpy.mock.calls[0][0], /HTTP 500/);
  assert.equal(result, false);
  errorSpy.mockRestore();
});

test("deliverAlertMatch: a rejected fetch (network error) propagates as a rejection rather than being swallowed here", async () => {
  const fetchFn = vi.fn(async () => {
    throw new Error("network down");
  });
  await assert.rejects(
    () =>
      deliverAlertMatch(
        triggerRow({
          channel: "discord",
          destination: "https://discord.com/api/webhooks/1/t",
        }),
        {},
        {},
        fetchFn,
      ),
    /network down/,
  );
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

// --- refreshTriggers: metric-snapshot refresh (#6746/#6747) -----------------

test("refreshTriggers: never fetches the metric snapshot when no active trigger has a condition", async () => {
  const calledUrls = [];
  const hub = new AlerterHub(
    {},
    {
      DATA_API: fakeDataApi(async (url) => {
        calledUrls.push(String(url));
        return new Response(
          JSON.stringify({ triggers: [triggerRow(), triggerRow({ id: "2" })] }),
          { status: 200 },
        );
      }),
      ALERT_TRIGGERS_INTERNAL_TOKEN: INTERNAL_TOKEN,
    },
  );
  await hub.refreshTriggers();
  assert.equal(calledUrls.length, 1);
  assert.ok(calledUrls[0].includes("alert-triggers-active"));
});

test("refreshTriggers: fetches the dereg-risk snapshot route when an active trigger has a condition, and populates the snapshot", async () => {
  const calledUrls = [];
  const hub = new AlerterHub(
    {},
    {
      DATA_API: fakeDataApi(async (url) => {
        const s = String(url);
        calledUrls.push(s);
        if (s.includes("alert-triggers-active")) {
          return new Response(
            JSON.stringify({
              triggers: [
                triggerRow({
                  condition: {
                    metric: "subnet_alpha_price_rank",
                    operator: "gt",
                    threshold: 100,
                  },
                }),
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            current_block: 1000,
            subnets: [{ netuid: 7, alpha_price_tao: 1 }],
            immune_neurons: [
              { netuid: 7, hotkey: "5Fhot", immunity_expires_at_block: 1500 },
            ],
          }),
          { status: 200 },
        );
      }),
      ALERT_TRIGGERS_INTERNAL_TOKEN: INTERNAL_TOKEN,
    },
  );
  await hub.refreshTriggers();
  assert.equal(calledUrls.length, 2);
  assert.ok(
    calledUrls.some((u) => u.includes("alert-triggers-dereg-risk-snapshot")),
  );
  assert.equal(hub.metricSnapshot.subnetAlphaPriceRank.get(7), 1);
  assert.equal(
    hub.metricSnapshot.neuronImmunityCountdownBlocks.get("7:5Fhot"),
    500,
  );
});

test("refreshTriggers: the metric-snapshot fetch carries the internal token header and a bounded AbortSignal", async () => {
  let receivedToken;
  let receivedSignal;
  const hub = new AlerterHub(
    {},
    {
      DATA_API: fakeDataApi(async (url, init) => {
        const s = String(url);
        if (s.includes("alert-triggers-active")) {
          return new Response(
            JSON.stringify({
              triggers: [
                triggerRow({
                  condition: {
                    metric: "subnet_alpha_price_rank",
                    operator: "gt",
                    threshold: 0,
                  },
                }),
              ],
            }),
            { status: 200 },
          );
        }
        receivedToken = init.headers["x-alert-triggers-internal-token"];
        receivedSignal = init.signal;
        return new Response(
          JSON.stringify({ current_block: 1, subnets: [], immune_neurons: [] }),
          { status: 200 },
        );
      }),
      ALERT_TRIGGERS_INTERNAL_TOKEN: INTERNAL_TOKEN,
    },
  );
  await hub.refreshTriggers();
  assert.equal(receivedToken, INTERNAL_TOKEN);
  assert.ok(receivedSignal instanceof AbortSignal);
});

test("refreshTriggers: a failed metric-snapshot fetch keeps the stale/empty snapshot, never throws", async () => {
  const hub = new AlerterHub(
    {},
    {
      DATA_API: fakeDataApi(async (url) => {
        const s = String(url);
        if (s.includes("alert-triggers-active")) {
          return new Response(
            JSON.stringify({
              triggers: [
                triggerRow({
                  condition: {
                    metric: "subnet_alpha_price_rank",
                    operator: "gt",
                    threshold: 0,
                  },
                }),
              ],
            }),
            { status: 200 },
          );
        }
        throw new Error("network down");
      }),
      ALERT_TRIGGERS_INTERNAL_TOKEN: INTERNAL_TOKEN,
    },
  );
  await assert.doesNotReject(() => hub.refreshTriggers());
  assert.equal(hub.metricSnapshot.subnetAlphaPriceRank.size, 0);
  assert.equal(hub.metricSnapshot.neuronImmunityCountdownBlocks.size, 0);
});

test("refreshTriggers: a non-ok metric-snapshot response keeps the stale/empty snapshot", async () => {
  const hub = new AlerterHub(
    {},
    {
      DATA_API: fakeDataApi(async (url) => {
        const s = String(url);
        if (s.includes("alert-triggers-active")) {
          return new Response(
            JSON.stringify({
              triggers: [
                triggerRow({
                  condition: {
                    metric: "subnet_alpha_price_rank",
                    operator: "gt",
                    threshold: 0,
                  },
                }),
              ],
            }),
            { status: 200 },
          );
        }
        return new Response("", { status: 500 });
      }),
      ALERT_TRIGGERS_INTERNAL_TOKEN: INTERNAL_TOKEN,
    },
  );
  await hub.refreshTriggers();
  assert.equal(hub.metricSnapshot.subnetAlphaPriceRank.size, 0);
});

test("refreshMetricSnapshot: a no-op when DATA_API/token is unbound, called directly (own defensive guard, independent of refreshTriggers' own check)", async () => {
  const hub = new AlerterHub({}, {});
  await assert.doesNotReject(() => hub.refreshMetricSnapshot());
  assert.equal(hub.metricSnapshot.subnetAlphaPriceRank.size, 0);
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

// --- refreshTriggers: lastDeliveredAt pruning (#5024) -------------------------

test("refreshTriggers: prunes lastDeliveredAt entries for trigger ids no longer present in the fresh triggers list", async () => {
  const hub = new AlerterHub(
    {},
    {
      DATA_API: fakeDataApi(
        async () =>
          new Response(
            JSON.stringify({ triggers: [triggerRow({ id: "1" })] }),
            { status: 200 },
          ),
      ),
      ALERT_TRIGGERS_INTERNAL_TOKEN: INTERNAL_TOKEN,
    },
  );
  // "1" is still active after the refresh; "2" and "3" are stale (deleted
  // or deactivated triggers whose rate-limit bookkeeping should not live
  // forever).
  hub.lastDeliveredAt.set("1", Date.now());
  hub.lastDeliveredAt.set("2", Date.now());
  hub.lastDeliveredAt.set("3", Date.now());
  await hub.refreshTriggers();
  assert.deepEqual([...hub.lastDeliveredAt.keys()], ["1"]);
});

test("refreshTriggers: never prunes lastDeliveredAt when the refresh fails (stale cache kept, not the trigger of a fetch that didn't happen)", async () => {
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
  hub.lastDeliveredAt.set("stale-but-untouched", Date.now());
  await hub.refreshTriggers();
  assert.equal(hub.lastDeliveredAt.has("stale-but-untouched"), true);
});

test("refreshTriggers: never prunes lastDeliveredAt when DATA_API/token is unbound (refresh skipped entirely)", async () => {
  const hub = new AlerterHub({}, {});
  hub.lastDeliveredAt.set("untouched", Date.now());
  await hub.refreshTriggers();
  assert.equal(hub.lastDeliveredAt.has("untouched"), true);
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

test("matchingTriggers: a condition trigger matches against the hub's own cached metricSnapshot", () => {
  const hub = new AlerterHub({}, {});
  hub.triggers = [
    triggerRow({
      id: "1",
      netuid: 7,
      condition: {
        metric: "subnet_alpha_price_rank",
        operator: "lte",
        threshold: 5,
      },
    }),
  ];
  hub.metricSnapshot = {
    subnetAlphaPriceRank: new Map([[7, 3]]),
    neuronImmunityCountdownBlocks: new Map(),
  };
  const matches = hub.matchingTriggers({ table: "account_events", netuid: 7 });
  assert.deepEqual(
    matches.map((t) => t.id),
    ["1"],
  );
});

test("evaluate: an end-to-end condition trigger delivers when refreshTriggers populates a matching metricSnapshot", async () => {
  const deliver = vi.fn().mockResolvedValue(true);
  const hub = new AlerterHub(
    {},
    {
      DATA_API: fakeDataApi(async (url) => {
        const s = String(url);
        if (s.includes("alert-triggers-active")) {
          return new Response(
            JSON.stringify({
              triggers: [
                triggerRow({
                  id: "1",
                  netuid: 7,
                  condition: {
                    metric: "subnet_alpha_price_rank",
                    operator: "eq",
                    threshold: 1,
                  },
                }),
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            current_block: 1,
            subnets: [{ netuid: 7, alpha_price_tao: 1 }],
            immune_neurons: [],
          }),
          { status: 200 },
        );
      }),
      ALERT_TRIGGERS_INTERNAL_TOKEN: INTERNAL_TOKEN,
    },
    { deliver },
  );
  const result = await hub.evaluate({ table: "account_events", netuid: 7 });
  assert.equal(result.matched, 1);
  assert.equal(result.delivered, 1);
  assert.equal(deliver.mock.calls.length, 1);
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
  const deliver = vi.fn().mockResolvedValue(true);
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
  const deliver = vi.fn().mockResolvedValue(true);
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
  const deliver = vi.fn().mockResolvedValue(true);
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
  const deliver = vi.fn().mockResolvedValue(true);
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

test("evaluate: a rejecting deliver call never fails the overall evaluation, and rolls back the rate-limit exactly like an explicit false return (#5023)", async () => {
  const deliver = vi.fn().mockRejectedValue(new Error("delivery exploded"));
  const hub = new AlerterHub({}, {}, { deliver });
  hub.triggers = [triggerRow({ id: "1", netuid: 7 })];
  hub.triggersLoadedAt = Date.now();
  const result = await hub.evaluate({ table: "account_events", netuid: 7 });
  assert.equal(result.matched, 1);
  assert.equal(result.delivered, 1); // still counted as "attempted"
  // The optimistic set is rolled back on a rejection exactly like an
  // explicit `false` return -- no prior entry existed, so it's deleted
  // outright, leaving the trigger free to retry on the very next match.
  assert.equal(hub.lastDeliveredAt.has("1"), false);
});

// --- evaluate: rate-limit rollback on failed delivery (#5023) -----------------

test("evaluate: an explicit `false` return from deliver rolls back the optimistic rate-limit set (no prior entry -> deleted outright)", async () => {
  const deliver = vi.fn().mockResolvedValue(false);
  const hub = new AlerterHub({}, {}, { deliver });
  hub.triggers = [triggerRow({ id: "1", netuid: 7 })];
  hub.triggersLoadedAt = Date.now();
  const result = await hub.evaluate({ table: "account_events", netuid: 7 });
  assert.equal(result.delivered, 1); // still attempted
  assert.equal(hub.lastDeliveredAt.has("1"), false);
});

test("evaluate: a failed delivery lets the VERY NEXT matching event retry immediately instead of waiting out the rate-limit window", async () => {
  const deliver = vi.fn().mockResolvedValue(false);
  const hub = new AlerterHub({}, {}, { deliver });
  hub.triggers = [triggerRow({ id: "1", netuid: 7 })];
  hub.triggersLoadedAt = Date.now();
  const payload = { table: "account_events", netuid: 7 };

  const first = await hub.evaluate(payload);
  assert.equal(first.delivered, 1);
  assert.equal(first.rate_limited, 0);

  // No sleep, no clock mocking -- if the rollback hadn't happened, this
  // second call (fired immediately after the first) would be rate-limited.
  const second = await hub.evaluate(payload);
  assert.equal(second.delivered, 1);
  assert.equal(second.rate_limited, 0);
  assert.equal(deliver.mock.calls.length, 2);
});

test("evaluate: a failed delivery rolls back to the PRIOR timestamp (not a full delete) when an earlier successful delivery already set one", async () => {
  const deliver = vi.fn();
  const hub = new AlerterHub({}, {}, { deliver });
  hub.triggers = [triggerRow({ id: "1", netuid: 7 })];
  hub.triggersLoadedAt = Date.now();
  const oldTimestamp = Date.now() - 10 * 60 * 1000; // well outside the window
  hub.lastDeliveredAt.set("1", oldTimestamp);

  deliver.mockResolvedValueOnce(false);
  const result = await hub.evaluate({ table: "account_events", netuid: 7 });
  assert.equal(result.delivered, 1); // attempted, but failed
  // Rolled back to the exact prior value, not deleted -- the Map still
  // reflects "last known good delivery was a while ago", which is also
  // "not currently rate-limited", so behavior is equivalent either way,
  // but this asserts the documented rollback mechanics precisely.
  assert.equal(hub.lastDeliveredAt.get("1"), oldTimestamp);
});

test("evaluate: a SUCCESSFUL delivery keeps the optimistic set in place (no rollback)", async () => {
  const deliver = vi.fn().mockResolvedValue(true);
  const hub = new AlerterHub({}, {}, { deliver });
  hub.triggers = [triggerRow({ id: "1", netuid: 7 })];
  hub.triggersLoadedAt = Date.now();
  const before = Date.now();
  await hub.evaluate({ table: "account_events", netuid: 7 });
  assert.ok(hub.lastDeliveredAt.get("1") >= before);
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

// --- writeBackMatchCounts (#5022) ----------------------------------------------

test("writeBackMatchCounts: no-op when DATA_API is unbound", async () => {
  const hub = new AlerterHub(
    {},
    { ALERT_TRIGGERS_INTERNAL_TOKEN: INTERNAL_TOKEN },
  );
  await assert.doesNotReject(() => hub.writeBackMatchCounts(["1"]));
});

test("writeBackMatchCounts: no-op when ALERT_TRIGGERS_INTERNAL_TOKEN is unset", async () => {
  let called = false;
  const hub = new AlerterHub(
    {},
    {
      DATA_API: fakeDataApi(async () => {
        called = true;
        return new Response(null, { status: 200 });
      }),
    },
  );
  await hub.writeBackMatchCounts(["1"]);
  assert.equal(called, false);
});

test("writeBackMatchCounts: no-op when triggerIds is empty", async () => {
  let called = false;
  const hub = new AlerterHub(
    {},
    {
      DATA_API: fakeDataApi(async () => {
        called = true;
        return new Response(null, { status: 200 });
      }),
      ALERT_TRIGGERS_INTERNAL_TOKEN: INTERNAL_TOKEN,
    },
  );
  await hub.writeBackMatchCounts([]);
  assert.equal(called, false);
});

test("writeBackMatchCounts: POSTs the matched trigger ids with the correct URL/header/body/timeout", async () => {
  let received;
  const hub = new AlerterHub(
    {},
    {
      DATA_API: fakeDataApi(async (url, init) => {
        received = { url: String(url), init };
        return new Response(null, { status: 200 });
      }),
      ALERT_TRIGGERS_INTERNAL_TOKEN: INTERNAL_TOKEN,
    },
  );
  await hub.writeBackMatchCounts(["1", "2"]);
  assert.equal(
    received.url,
    "https://data-api.internal/api/v1/internal/alert-triggers/matched",
  );
  assert.equal(received.init.method, "POST");
  assert.equal(
    received.init.headers["x-alert-triggers-internal-token"],
    INTERNAL_TOKEN,
  );
  assert.deepEqual(JSON.parse(received.init.body), {
    trigger_ids: ["1", "2"],
  });
  assert.ok(received.init.signal instanceof AbortSignal);
});

test("writeBackMatchCounts: logs but never throws on a non-ok response", async () => {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const hub = new AlerterHub(
    {},
    {
      DATA_API: fakeDataApi(async () => new Response(null, { status: 500 })),
      ALERT_TRIGGERS_INTERNAL_TOKEN: INTERNAL_TOKEN,
    },
  );
  await assert.doesNotReject(() => hub.writeBackMatchCounts(["1"]));
  assert.equal(errorSpy.mock.calls.length, 1);
  assert.match(errorSpy.mock.calls[0][0], /HTTP 500/);
  errorSpy.mockRestore();
});

test("writeBackMatchCounts: never throws when the fetch itself rejects (network error / AbortSignal timeout)", async () => {
  const hub = new AlerterHub(
    {},
    {
      DATA_API: fakeDataApi(async () => {
        throw new Error("timeout");
      }),
      ALERT_TRIGGERS_INTERNAL_TOKEN: INTERNAL_TOKEN,
    },
  );
  await assert.doesNotReject(() => hub.writeBackMatchCounts(["1"]));
});

// --- evaluate: write-back integration (#5022) ----------------------------------

test("evaluate: writes back the FULL matched trigger id list, including a match that was rate-limited (not just the ones that clear it)", async () => {
  let receivedBody;
  const deliver = vi.fn().mockResolvedValue(true);
  const hub = new AlerterHub(
    {},
    {
      DATA_API: fakeDataApi(async (_url, init) => {
        receivedBody = JSON.parse(init.body);
        return new Response(null, { status: 200 });
      }),
      ALERT_TRIGGERS_INTERNAL_TOKEN: INTERNAL_TOKEN,
    },
    { deliver },
  );
  hub.triggers = [
    triggerRow({ id: "1", netuid: 7 }),
    triggerRow({ id: "2", netuid: 7 }),
  ];
  hub.triggersLoadedAt = Date.now();
  hub.lastDeliveredAt.set("1", Date.now()); // "1" starts inside its rate-limit window
  const result = await hub.evaluate({ table: "account_events", netuid: 7 });
  assert.equal(result.rate_limited, 1);
  assert.equal(result.delivered, 1);
  assert.deepEqual(receivedBody.trigger_ids.sort(), ["1", "2"]);
});

test("evaluate: the delivery fan-out and the match-count write-back run CONCURRENTLY, not sequentially", async () => {
  let resolveDelivery;
  const deliver = vi.fn(
    () =>
      new Promise((resolve) => {
        resolveDelivery = () => resolve(true);
      }),
  );
  let writebackObserved = false;
  const hub = new AlerterHub(
    {},
    {
      DATA_API: fakeDataApi(async () => {
        writebackObserved = true;
        return new Response(null, { status: 200 });
      }),
      ALERT_TRIGGERS_INTERNAL_TOKEN: INTERNAL_TOKEN,
    },
    { deliver },
  );
  hub.triggers = [triggerRow({ id: "1", netuid: 7 })];
  hub.triggersLoadedAt = Date.now();
  const evaluatePromise = hub.evaluate({ table: "account_events", netuid: 7 });
  // Let every microtask-queued step run -- if the write-back were
  // sequenced AFTER the delivery fan-out (the bug this test guards
  // against), it could never have started yet, since delivery is
  // deliberately held open below.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(writebackObserved, true);
  resolveDelivery();
  await evaluatePromise;
});

test("evaluate: a write-back failure never affects the evaluate() response shape", async () => {
  const deliver = vi.fn().mockResolvedValue(true);
  const hub = new AlerterHub(
    {},
    {
      DATA_API: fakeDataApi(async () => {
        throw new Error("data-api unreachable");
      }),
      ALERT_TRIGGERS_INTERNAL_TOKEN: INTERNAL_TOKEN,
    },
    { deliver },
  );
  hub.triggers = [triggerRow({ id: "1", netuid: 7 })];
  hub.triggersLoadedAt = Date.now();
  const result = await hub.evaluate({ table: "account_events", netuid: 7 });
  assert.deepEqual(result, {
    matched: 1,
    trigger_ids: ["1"],
    delivered: 1,
    rate_limited: 0,
  });
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
