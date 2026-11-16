import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import { Client } from "pg";
import {
  createPgStoreRuntime,
  type PgStoreRuntime,
} from "../src/pg-store-runtime.ts";
import {
  createPgSubnetStatusHub,
  type NativeSubnetStatusOptions,
} from "../src/pg-subnet-status-hub.ts";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";

const connectionString = pg18FixtureUrl().toString();
const control = new Client({
  connectionString,
  connectionTimeoutMillis: 2000,
  statement_timeout: 5000,
});
const migration = readFileSync(
  new URL(
    "../migrations/postgres/0031_subnet_status_actor.sql",
    import.meta.url,
  ),
  "utf8",
);
const options: NativeSubnetStatusOptions = {
  maxConcurrentRequests: 4,
  maxRequestBytes: 8192,
  maxStateBytes: 131072,
  maxMemberships: 1000,
  notificationConcurrency: 2,
  executionTimeoutMillis: 30000,
  drainTimeoutMillis: 1000,
  notify: async () => {},
  onBackgroundError: () => {},
};
const request = (path: string, body: unknown) =>
  new Request(`https://subnet-status.invalid${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
let runtime: PgStoreRuntime;
const hubs: Awaited<ReturnType<typeof createPgSubnetStatusHub>>[] = [];
const storedState = async () =>
  JSON.parse(
    (await control.query("SELECT state FROM realtime.subnet_status_actor"))
      .rows[0].state,
  );
const peer = async (overrides: Partial<NativeSubnetStatusOptions> = {}) => {
  const value = await createPgSubnetStatusHub(runtime, {
    ...options,
    ...overrides,
  });
  hubs.push(value);
  return value;
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe(
  "native subnet-status membership on PostgreSQL",
  { concurrency: false },
  () => {
    before(async () => {
      await control.connect();
      runtime = createPgStoreRuntime({
        connectionString,
        maxConnections: 4,
        connectionTimeoutMillis: 2000,
        idleTimeoutMillis: 1000,
        statementTimeoutMillis: 5000,
        onIdleError: (error) => {
          throw error;
        },
      });
    });
    beforeEach(async () => {
      await Promise.all(hubs.splice(0).map((hub) => hub.close()));
      await control.query("DROP SCHEMA IF EXISTS realtime CASCADE");
      await control.query(migration);
    });
    after(async () => {
      await Promise.all(hubs.map((hub) => hub.close()));
      await runtime.close();
      try {
        await control.query("DROP SCHEMA IF EXISTS realtime CASCADE");
      } finally {
        await control.end();
      }
    });

    it("serializes competing process writers and survives a fresh process", async () => {
      const first = await peer(),
        second = await peer();
      await Promise.all([
        first.fetch(request("/mcp-subscribe", { sessionId: "A", netuid: 7 })),
        second.fetch(request("/mcp-subscribe", { sessionId: "B", netuid: 7 })),
      ]);
      assert.deepEqual(await storedState(), { byNetuid: { "7": ["A", "B"] } });
      await first.close();
      await second.close();
      const restarted = await peer();
      await restarted.fetch(
        request("/mcp-unsubscribe-session", { sessionId: "A" }),
      );
      assert.deepEqual(await storedState(), { byNetuid: { "7": ["B"] } });
    });
    it("releases the only shared pool connection before outbound session notification", async () => {
      const single = createPgStoreRuntime({
        connectionString,
        maxConnections: 1,
        connectionTimeoutMillis: 2000,
        idleTimeoutMillis: 1000,
        statementTimeoutMillis: 5000,
        onIdleError: (error) => {
          throw error;
        },
      });
      const entered = deferred(),
        release = deferred();
      const sending = await createPgSubnetStatusHub(single, {
        ...options,
        notify: async () => {
          entered.resolve();
          await release.promise;
        },
      });
      const writing = await createPgSubnetStatusHub(single, options);
      try {
        await sending.fetch(
          request("/mcp-subscribe", { sessionId: "A", netuid: 7 }),
        );
        const response = sending.fetch(
          request("/notify-changed", { netuids: [7] }),
        );
        await entered.promise;
        await writing.fetch(
          request("/mcp-subscribe", { sessionId: "B", netuid: 7 }),
        );
        release.resolve();
        assert.deepEqual(await (await response).json(), {
          ok: true,
          delivered: 1,
        });
      } finally {
        release.resolve();
        await sending.close();
        await writing.close();
        await single.close();
      }
    });
    it("preserves NUL and lone-surrogate session strings through PostgreSQL JSON text", async () => {
      const hub = await peer();
      const ids = ["nul\u0000session", "lone\ud800session", "low\udc00session"];
      for (const sessionId of ids)
        await hub.fetch(request("/mcp-subscribe", { sessionId, netuid: 7 }));
      assert.deepEqual(await storedState(), {
        byNetuid: { "7": [...ids].sort() },
      });
      const raw = (
        await control.query("SELECT state FROM realtime.subnet_status_actor")
      ).rows[0].state;
      assert.equal(raw, JSON.stringify({ byNetuid: { "7": [...ids].sort() } }));
      const restored = await peer();
      await restored.fetch(
        request("/mcp-unsubscribe", { sessionId: ids[0], netuid: 7 }),
      );
      assert.deepEqual(await storedState(), {
        byNetuid: { "7": ids.slice(1).sort() },
      });
    });

    it("rejects incompatible policy and atomically rolls back membership overflow", async () => {
      const hub = await peer({ maxMemberships: 1 });
      await hub.fetch(request("/mcp-subscribe", { sessionId: "A", netuid: 7 }));
      await assert.rejects(
        hub.fetch(request("/mcp-subscribe", { sessionId: "B", netuid: 7 })),
        /capacity/,
      );
      assert.deepEqual(await storedState(), { byNetuid: { "7": ["A"] } });
      await assert.rejects(peer(), /policy differs/);
      await assert.rejects(
        control.query("UPDATE realtime.subnet_status_actor SET state='[]'"),
      );
    });
  },
);
