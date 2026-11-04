import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import { Client } from "pg";
import {
  createPgStoreRuntime,
  type PgStoreRuntime,
} from "../src/pg-store-runtime.ts";
import {
  createNativeMcpSessions,
  type NativeMcpSessionOptions,
} from "../src/native-mcp-sessions.ts";
import { createPgSubnetStatusHub } from "../src/pg-subnet-status-hub.ts";
import { createPgMcpSessionStore } from "../src/pg-mcp-session-store.ts";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";

const connectionString = pg18FixtureUrl().toString();
const control = new Client({
  connectionString,
  connectionTimeoutMillis: 2000,
  statement_timeout: 5000,
});
const migrations = [
  "0031_subnet_status_actor.sql",
  "0032_mcp_sessions.sql",
].map((name) =>
  readFileSync(
    new URL(`../migrations/postgres/${name}`, import.meta.url),
    "utf8",
  ),
);
const ok = { fetch: async () => new Response('{"ok":true}') };
const options: NativeMcpSessionOptions = {
  maxSessions: 100,
  maxBytes: 1000000,
  maxStateBytes: 131072,
  leaseMilliseconds: 60000,
  maxResidentSessions: 4,
  maxConcurrentCalls: 8,
  maxPendingCallsPerSession: 4,
  maxRequestBytes: 8192,
  maxQueuedFrames: 4,
  renewIntervalMillis: 10000,
  residentIdleMillis: 30000,
  executionTimeoutMillis: 20000,
  drainTimeoutMillis: 1000,
  subnetStatus: ok,
  chainFirehose: ok,
  onBackgroundError: () => {},
};
let runtime: PgStoreRuntime;
const services: Awaited<ReturnType<typeof createNativeMcpSessions>>[] = [];
const request = (path: string, body?: unknown) =>
  new Request(
    `https://session.invalid${path}`,
    body === undefined ? {} : { method: "POST", body: JSON.stringify(body) },
  );
const peer = async (overrides: Partial<NativeMcpSessionOptions> = {}) => {
  const service = await createNativeMcpSessions(runtime, {
    ...options,
    ...overrides,
  });
  services.push(service);
  return service;
};
const state = async (id: string) =>
  JSON.parse(
    (
      await control.query(
        "SELECT state FROM realtime.mcp_sessions WHERE session_key=$1",
        [JSON.stringify(id)],
      )
    ).rows[0].state,
  );

describe("resident MCP sessions on PostgreSQL", { concurrency: false }, () => {
  before(async () => {
    await control.connect();
    runtime = createPgStoreRuntime({
      connectionString,
      maxConnections: 1,
      connectionTimeoutMillis: 2000,
      idleTimeoutMillis: 1000,
      statementTimeoutMillis: 5000,
      onIdleError: (error) => {
        throw error;
      },
    });
  });
  beforeEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.close()));
    await control.query("DROP SCHEMA IF EXISTS realtime CASCADE");
    for (const migration of migrations) await control.query(migration);
  });
  after(async () => {
    await Promise.all(services.map((service) => service.close()));
    await runtime.close();
    try {
      await control.query("DROP SCHEMA IF EXISTS realtime CASCADE");
    } finally {
      await control.end();
    }
  });

  it("composes native membership and live SSE through a one-connection pool", async () => {
    let session!: Awaited<ReturnType<typeof createNativeMcpSessions>>;
    const subnet = await createPgSubnetStatusHub(runtime, {
      maxConcurrentRequests: 4,
      maxRequestBytes: 8192,
      maxStateBytes: 131072,
      maxMemberships: 1000,
      notificationConcurrency: 2,
      executionTimeoutMillis: 20000,
      drainTimeoutMillis: 1000,
      notify: async (id, uri, signal) =>
        session.fetch(id, new Request(request("/notify", { uri }), { signal })),
      onBackgroundError: () => {},
    });
    try {
      session = await peer({ subnetStatus: subnet });
      await session.fetch("A", request("/register", { sessionId: "A" }));
      await session.fetch(
        "A",
        request("/subscribe", {
          sessionId: "A",
          uri: "metagraph://subnet/7/status",
        }),
      );
      const stream = await session.fetch("A", request("/stream?sessionId=A"));
      const reader = stream.body!.getReader();
      const pending = reader.read();
      await runtime.producer.query("SELECT 1");
      const notified = await subnet.fetch(
        request("/notify-changed", { netuids: [7] }),
      );
      assert.deepEqual(await notified.json(), { ok: true, delivered: 1 });
      assert.match(
        new TextDecoder().decode((await pending).value),
        /notifications\/resources\/updated/,
      );
      assert.equal((await state("A")).sequence, 1);
      await reader.cancel();
      await session.fetch("A", request("/terminate", { sessionId: "A" }));
      assert.equal((await state("A")).terminated, true);
    } finally {
      await subnet.close();
    }
  });

  it("preserves pending state after ownership release and fences stale prior tokens", async () => {
    const first = await peer(),
      second = await peer();
    await first.fetch("A", request("/register", { sessionId: "A" }));
    await first.fetch(
      "A",
      request("/subscribe", {
        sessionId: "A",
        uri: "metagraph://subnet/7/status",
      }),
    );
    await first.fetch(
      "A",
      request("/notify", { uri: "metagraph://subnet/7/status" }),
    );
    const old = (await control.query("SELECT * FROM realtime.mcp_sessions"))
      .rows[0];
    await assert.rejects(
      second.fetch("A", request("/stream?sessionId=A")),
      /another process/,
    );
    await first.close();
    const stream = await second.fetch("A", request("/stream?sessionId=A"));
    const reader = stream.body!.getReader();
    assert.match(
      new TextDecoder().decode((await reader.read()).value),
      /id: 1/,
    );
    const oldStore = await createPgMcpSessionStore(runtime, options);
    const lease = {
      key: old.session_key,
      token: old.owner_token,
      state: old.state,
      nowMs: 0,
      expiresAtMs: 0,
      alarmVersion: 0,
    };
    await assert.rejects(
      oldStore.save(lease, JSON.stringify({ sessionId: "A", sequence: 900 })),
      /ownership/,
    );
    assert.equal((await state("A")).sequence, 1);
    await reader.cancel();
  });

  it("runs the actual idle cleanup and preserves a later retry alarm", async () => {
    let failed = true;
    const session = await peer({
      subnetStatus: {
        fetch: async (req) => {
          if (
            failed &&
            new URL(req.url).pathname === "/mcp-unsubscribe-session"
          )
            throw new Error("reverse unavailable");
          return new Response("{}");
        },
      },
    });
    await session.fetch("A", request("/register", { sessionId: "A" }));
    await session.fetch(
      "A",
      request("/subscribe", {
        sessionId: "A",
        uri: "metagraph://subnet/7/status",
      }),
    );
    await control.query("UPDATE realtime.mcp_sessions SET alarm_at_ms=0");
    assert.deepEqual(await session.runDueAlarms(10), {
      completed: 0,
      rearmed: 1,
      skipped: 0,
      failed: 0,
    });
    assert.equal((await state("A")).terminated, false);
    failed = false;
    await control.query("UPDATE realtime.mcp_sessions SET alarm_at_ms=0");
    assert.deepEqual(await session.runDueAlarms(10), {
      completed: 1,
      rearmed: 0,
      skipped: 0,
      failed: 0,
    });
    assert.equal((await state("A")).terminated, true);
  });

  it("stores NUL and lone-surrogate identifiers without JSONB loss", async () => {
    const id = "nul\u0000lone\ud800";
    const session = await peer();
    await session.fetch(id, request("/register", { sessionId: id }));
    assert.equal((await state(id)).sessionId, id);
    const raw = (
      await control.query("SELECT session_key,state FROM realtime.mcp_sessions")
    ).rows[0];
    assert.equal(raw.session_key, JSON.stringify(id));
    assert.equal(JSON.parse(raw.state).sessionId, id);
  });
});
