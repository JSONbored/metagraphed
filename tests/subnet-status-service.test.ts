import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { test } from "vitest";
import {
  subnetStatusNotifier,
  subnetStatusService,
} from "../src/subnet-status-service.ts";
import { notifySubnetStatusChanged } from "../src/subnet-status-subscribe.ts";
import { McpSessionHub } from "../workers/mcp-session-hub.ts";
import type { McpSessionHubState } from "../workers/do-state.ts";
import { apiEnv } from "./helpers/worker-env.ts";
import {
  subnetStatusFixture,
  subnetStatusOptions,
} from "./helpers/subnet-status-fixture.ts";

const req = (path: string, body: unknown) =>
  new Request(`https://session.invalid${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
function sessionState(): McpSessionHubState {
  const stored = new Map<string, unknown>();
  return {
    blockConcurrencyWhile: async (callback) => callback(),
    waitUntil: () => {},
    storage: {
      get: async (keys) =>
        new Map(
          keys
            .filter((key) => stored.has(key))
            .map((key) => [key, stored.get(key)]),
        ),
      put: async (entries) => {
        for (const [key, value] of Object.entries(entries))
          stored.set(key, value);
      },
      setAlarm: async () => {},
    },
  };
}

test("native service selection fails closed and preserves absent Worker behavior", async () => {
  assert.equal(subnetStatusService(undefined), undefined);
  assert.equal(subnetStatusService(null), undefined);
  assert.equal(subnetStatusService({}), undefined);
  const service = { fetch: async () => new Response("native") };
  assert.equal(
    await subnetStatusService({ SUBNET_STATUS_SERVICE: service })!
      .fetch("https://native.invalid")
      .then((response) => response.text()),
    "native",
  );
  for (const value of [null, false, {}, { fetch: "invalid" }])
    assert.throws(
      () => subnetStatusService({ SUBNET_STATUS_SERVICE: value }),
      /Invalid native/,
    );
  assert.equal(subnetStatusNotifier(undefined), undefined);
  for (const value of [
    null,
    {},
    { notify: () => {}, maxConcurrent: 0 },
    { notify: () => {}, maxConcurrent: 101 },
    { notify: () => {}, maxConcurrent: NaN },
    { notify: 4, maxConcurrent: 1 },
  ])
    assert.throws(() => subnetStatusNotifier(value), /Invalid native/);
  const notifier = { notify: async () => {}, maxConcurrent: 1 };
  assert.equal(subnetStatusNotifier(notifier), notifier);
  assert.deepEqual(
    await notifySubnetStatusChanged(apiEnv({ SUBNET_STATUS_SERVICE: {} }), [1]),
    { notified: false, reason: "fetch_failed" },
  );
});

test("MCP membership and health producers use the same explicitly selected native service", async () => {
  const db = new PGlite();
  const delivered: { sessionId: string; uri: string }[] = [];
  const { hub } = await subnetStatusFixture(db, {
    ...subnetStatusOptions,
    notify: async (sessionId, uri) => {
      delivered.push({ sessionId, uri });
    },
  });
  const env = apiEnv({
    SUBNET_STATUS_SERVICE: hub,
    SUBNET_STATUS_HUB: {
      get: () => {
        throw new Error("legacy fallback");
      },
    },
  });
  const mcp = new McpSessionHub(sessionState(), env);
  const sessionId = "native-session",
    uri = "metagraph://subnet/7/status";
  try {
    assert.equal(
      (await mcp.fetch(req("/register", { sessionId }))).status,
      200,
    );
    assert.equal(
      (await mcp.fetch(req("/subscribe", { sessionId, uri }))).status,
      200,
    );
    assert.deepEqual(await notifySubnetStatusChanged(env, [7]), {
      notified: true,
    });
    assert.deepEqual(delivered, [{ sessionId, uri }]);
    assert.equal(
      (await mcp.fetch(req("/unsubscribe", { sessionId, uri }))).status,
      200,
    );
    await notifySubnetStatusChanged(env, [7]);
    assert.equal(delivered.length, 1);
    await mcp.fetch(req("/subscribe", { sessionId, uri }));
    assert.equal(
      (await mcp.fetch(req("/terminate", { sessionId }))).status,
      200,
    );
    await notifySubnetStatusChanged(env, [7]);
    assert.equal(delivered.length, 1);
    const row = (
      await db.query<{ state: unknown }>(
        "SELECT state FROM realtime.subnet_status_actor",
      )
    ).rows[0]!;
    assert.deepEqual(JSON.parse(String(row.state)), { byNetuid: {} });
  } finally {
    await hub.close();
    await db.close();
  }
});

test("native reverse membership failures preserve MCP's existing error behavior", async () => {
  const env = apiEnv({
    SUBNET_STATUS_SERVICE: {
      fetch: async () => new Response("failed", { status: 503 }),
    },
  });
  const mcp = new McpSessionHub(sessionState(), env);
  const body = {
    sessionId: "native-session",
    uri: "metagraph://subnet/7/status",
  };
  await mcp.fetch(req("/register", body));
  await assert.rejects(
    mcp.fetch(req("/subscribe", body)),
    /Subnet subscription registration failed/,
  );
  await assert.rejects(
    mcp.fetch(req("/unsubscribe", body)),
    /Subnet unsubscription failed/,
  );
  await assert.rejects(
    mcp.fetch(req("/terminate", body)),
    /Subnet unsubscription failed/,
  );
});
