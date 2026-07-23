// Unit tests for workers/subnet-status-hub.mjs (#6034).
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  SubnetStatusHub,
  addSessionSubscription,
  hydrateSubscriptionIndex,
  removeSessionEverywhere,
  removeSessionSubscription,
  serializeSubscriptionIndex,
} from "../workers/subnet-status-hub.ts";
import type { Row } from "./row-type.ts";
import { buildSubnetStatusResourceUri } from "../src/subnet-status-subscribe.ts";

function createStubStorage(initial: Row = {}) {
  const data = new Map(Object.entries(initial));
  return {
    async get(keys: string[]) {
      const result = new Map();
      for (const key of keys) {
        if (data.has(key)) result.set(key, data.get(key));
      }
      return result;
    },
    async put(entries: Row) {
      for (const [key, value] of Object.entries(entries)) {
        data.set(key, value);
      }
    },
    get raw() {
      return data;
    },
  };
}

function stubState(initial: Row = {}): DurableObjectState {
  return {
    storage: createStubStorage(initial),
  } as unknown as DurableObjectState;
}

function fakeMcpSessionHubBinding() {
  const calls: Row[] = [];
  return {
    calls,
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (url: string, init?: RequestInit) => {
        calls.push({
          url,
          body: init?.body ? JSON.parse(init.body as string) : null,
        });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    }),
  };
}

function jsonRequest(url: string, body: unknown) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("index helpers: add/remove/serialize/hydrate round-trip", () => {
  const byNetuid = new Map();
  const sessionByNetuid = new Map();
  addSessionSubscription(byNetuid, sessionByNetuid, "s1", 1);
  addSessionSubscription(byNetuid, sessionByNetuid, "s2", 1);
  addSessionSubscription(byNetuid, sessionByNetuid, "s1", 2);
  assert.deepEqual([...byNetuid.get(1)].sort(), ["s1", "s2"]);
  assert.deepEqual([...sessionByNetuid.get("s1")].sort(), [1, 2]);

  removeSessionSubscription(byNetuid, sessionByNetuid, "s1", 1);
  assert.deepEqual([...byNetuid.get(1)], ["s2"]);
  assert.deepEqual([...sessionByNetuid.get("s1")], [2]);

  removeSessionEverywhere(byNetuid, sessionByNetuid, "s1");
  assert.equal(sessionByNetuid.has("s1"), false);
  assert.equal(byNetuid.has(2), false);

  const serialized = serializeSubscriptionIndex(byNetuid);
  assert.deepEqual(serialized, { 1: ["s2"] });
  const revived = hydrateSubscriptionIndex(serialized);
  assert.deepEqual([...revived.byNetuid.get(1)!], ["s2"]);
});

test("handleSubscribe: registers session for a netuid and persists", async () => {
  const state = stubState();
  const hub = new SubnetStatusHub(state, {} as unknown as Env);
  const res = await hub.fetch(
    jsonRequest("https://subnet-status-hub.internal/mcp-subscribe", {
      sessionId: "session-1",
      netuid: 42,
    }),
  );
  assert.equal(res.status, 200);
  assert.equal(hub.byNetuid.get(42)!.has("session-1"), true);
  assert.deepEqual((state.storage as Row).raw.get("byNetuid"), {
    42: ["session-1"],
  });
});

test("handleSubscribe: rejects missing sessionId / netuid", async () => {
  const hub = new SubnetStatusHub(stubState(), {} as unknown as Env);
  const missingSession = await hub.fetch(
    jsonRequest("https://subnet-status-hub.internal/mcp-subscribe", {
      netuid: 1,
    }),
  );
  assert.equal(missingSession.status, 400);
  const missingNetuid = await hub.fetch(
    jsonRequest("https://subnet-status-hub.internal/mcp-subscribe", {
      sessionId: "s",
    }),
  );
  assert.equal(missingNetuid.status, 400);
});

test("handleUnsubscribe + unsubscribe-session clear membership", async () => {
  const hub = new SubnetStatusHub(stubState(), {} as unknown as Env);
  await hub.fetch(
    jsonRequest("https://subnet-status-hub.internal/mcp-subscribe", {
      sessionId: "session-1",
      netuid: 1,
    }),
  );
  await hub.fetch(
    jsonRequest("https://subnet-status-hub.internal/mcp-subscribe", {
      sessionId: "session-1",
      netuid: 2,
    }),
  );
  await hub.fetch(
    jsonRequest("https://subnet-status-hub.internal/mcp-unsubscribe", {
      sessionId: "session-1",
      netuid: 1,
    }),
  );
  assert.equal(hub.byNetuid.has(1), false);
  assert.equal(hub.byNetuid.get(2)!.has("session-1"), true);

  await hub.fetch(
    jsonRequest("https://subnet-status-hub.internal/mcp-unsubscribe-session", {
      sessionId: "session-1",
    }),
  );
  assert.equal(hub.byNetuid.has(2), false);
  assert.equal(hub.sessionByNetuid.has("session-1"), false);
});

test("handleNotifyChanged: fans out only to subscribed sessions for changed netuids", async () => {
  const sessions = fakeMcpSessionHubBinding();
  const hub = new SubnetStatusHub(stubState(), {
    MCP_SESSION_HUB: sessions,
  } as unknown as Env);
  await hub.fetch(
    jsonRequest("https://subnet-status-hub.internal/mcp-subscribe", {
      sessionId: "interested",
      netuid: 7,
    }),
  );
  await hub.fetch(
    jsonRequest("https://subnet-status-hub.internal/mcp-subscribe", {
      sessionId: "other",
      netuid: 9,
    }),
  );
  const res = await hub.fetch(
    jsonRequest("https://subnet-status-hub.internal/notify-changed", {
      netuids: [7, 99],
    }),
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(body.delivered, 1);
  assert.equal(sessions.calls.length, 1);
  assert.match(sessions.calls[0].url, /\/notify$/);
  assert.deepEqual(sessions.calls[0].body, {
    uri: buildSubnetStatusResourceUri(7),
  });
});

test("handleNotifyChanged: best-effort — a failing session does not abort others", async () => {
  let n = 0;
  const sessions = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async () => {
        n += 1;
        if (n === 1) throw new Error("boom");
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    }),
  } as unknown as DurableObjectNamespace;
  const hub = new SubnetStatusHub(stubState(), {
    MCP_SESSION_HUB: sessions,
  } as unknown as Env);
  await hub.fetch(
    jsonRequest("https://subnet-status-hub.internal/mcp-subscribe", {
      sessionId: "a",
      netuid: 1,
    }),
  );
  await hub.fetch(
    jsonRequest("https://subnet-status-hub.internal/mcp-subscribe", {
      sessionId: "b",
      netuid: 1,
    }),
  );
  const res = await hub.fetch(
    jsonRequest("https://subnet-status-hub.internal/notify-changed", {
      netuids: [1],
    }),
  );
  const body = (await res.json()) as Row;
  assert.equal(body.delivered, 1);
});

test("handleNotifyChanged: empty list or unbound MCP_SESSION_HUB delivers 0", async () => {
  const hub = new SubnetStatusHub(stubState(), {} as unknown as Env);
  const empty = await hub.fetch(
    jsonRequest("https://subnet-status-hub.internal/notify-changed", {
      netuids: [1],
    }),
  );
  assert.deepEqual(await empty.json(), { ok: true, delivered: 0 });

  const hub2 = new SubnetStatusHub(stubState(), {
    MCP_SESSION_HUB: fakeMcpSessionHubBinding(),
  } as unknown as Env);
  const none = await hub2.fetch(
    jsonRequest("https://subnet-status-hub.internal/notify-changed", {
      netuids: [],
    }),
  );
  assert.deepEqual(await none.json(), { ok: true, delivered: 0 });

  const bad = await hub2.fetch(
    jsonRequest("https://subnet-status-hub.internal/notify-changed", {
      netuids: "not-an-array",
    }),
  );
  assert.deepEqual(await bad.json(), { ok: true, delivered: 0 });
});

test("handleSubscribe: accepts a status URI string as netuid", async () => {
  const hub = new SubnetStatusHub(stubState(), {} as unknown as Env);
  const res = await hub.fetch(
    jsonRequest("https://subnet-status-hub.internal/mcp-subscribe", {
      sessionId: "session-1",
      netuid: "metagraph://subnet/9/status",
    }),
  );
  assert.equal(res.status, 200);
  assert.equal(hub.byNetuid.get(9)!.has("session-1"), true);
});

test("index helpers: ignore invalid sessionId / netuid inputs", () => {
  const byNetuid = new Map();
  const sessionByNetuid = new Map();
  addSessionSubscription(byNetuid, sessionByNetuid, "", 1);
  addSessionSubscription(byNetuid, sessionByNetuid, "s", -1);
  addSessionSubscription(byNetuid, sessionByNetuid, null, 1);
  removeSessionSubscription(byNetuid, sessionByNetuid, "", 1);
  removeSessionSubscription(byNetuid, sessionByNetuid, "s", -1);
  removeSessionSubscription(byNetuid, sessionByNetuid, "missing", 1);
  removeSessionEverywhere(byNetuid, sessionByNetuid, "missing");
  assert.equal(byNetuid.size, 0);
  assert.equal(hydrateSubscriptionIndex(null).byNetuid.size, 0);
  const revived = hydrateSubscriptionIndex({
    bad: "x",
    "-1": ["s"],
    2: ["ok", ""],
    3: "not-array",
  });
  assert.deepEqual([...revived.byNetuid.get(2)!], ["ok"]);
  assert.equal(revived.byNetuid.has(-1), false);
  assert.equal(revived.byNetuid.has(3), false);
});

test("handleUnsubscribe / unsubscribe-session no-op on bad payloads", async () => {
  const hub = new SubnetStatusHub(stubState(), {} as unknown as Env);
  const badUnsub = await hub.fetch(
    jsonRequest("https://subnet-status-hub.internal/mcp-unsubscribe", {
      sessionId: 9,
      netuid: "x",
    }),
  );
  assert.equal(badUnsub.status, 200);
  const badSession = await hub.fetch(
    jsonRequest("https://subnet-status-hub.internal/mcp-unsubscribe-session", {
      sessionId: 9,
    }),
  );
  assert.equal(badSession.status, 200);
});

test("unknown route and wrong method return 404", async () => {
  const hub = new SubnetStatusHub(stubState(), {} as unknown as Env);
  const missing = await hub.fetch(
    new Request("https://subnet-status-hub.internal/nope", { method: "GET" }),
  );
  assert.equal(missing.status, 404);
  const wrongMethod = await hub.fetch(
    new Request("https://subnet-status-hub.internal/notify-changed", {
      method: "GET",
    }),
  );
  assert.equal(wrongMethod.status, 404);
});
