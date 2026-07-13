// Unit tests for workers/alerter-hub.mjs (#4984 Part 2). No Durable Object
// runtime needed -- state.storage is never touched by this class (the
// trigger cache is plain in-memory instance state, refreshed from
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

test("deliverAlertMatch: the default hook resolves without throwing (Part 3 replaces its body)", async () => {
  await assert.doesNotReject(() =>
    deliverAlertMatch(triggerRow(), { table: "account_events" }, {}),
  );
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
  assert.equal(deliver.mock.calls.length, 2);
  assert.equal(deliver.mock.calls[0][1], payload);
});

test("evaluate: a rejecting deliver call never fails the overall evaluation", async () => {
  const deliver = vi.fn().mockRejectedValue(new Error("delivery exploded"));
  const hub = new AlerterHub({}, {}, { deliver });
  hub.triggers = [triggerRow({ netuid: 7 })];
  hub.triggersLoadedAt = Date.now();
  const result = await hub.evaluate({ table: "account_events", netuid: 7 });
  assert.equal(result.matched, 1);
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
