import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, test, vi } from "vitest";
import { createPgSubnetStatusHub } from "../src/pg-subnet-status-hub.ts";
import { SubnetStatusHub } from "../workers/subnet-status-hub.ts";
import {
  subnetStatusFixture,
  subnetStatusOptions,
} from "./helpers/subnet-status-fixture.ts";
import { queueDeferred } from "./helpers/queue-fixture.ts";

let db: PGlite;
let f: Awaited<ReturnType<typeof subnetStatusFixture>>;
beforeAll(() => {
  db = new PGlite();
});
beforeEach(async () => {
  f = await subnetStatusFixture(db);
});
afterAll(async () => {
  await db.close();
});
const request = (path: string, body: unknown, signal?: AbortSignal) =>
  new Request(`https://subnet-status.invalid${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
const state = async () =>
  JSON.parse(
    (
      await db.query<{ state: string }>(
        "SELECT state FROM realtime.subnet_status_actor",
      )
    ).rows[0]!.state,
  );

test("requires bounded policy and an explicit notifier, and snapshots its options", async () => {
  for (const [key, values] of Object.entries({
    maxConcurrentRequests: [0, 65, NaN],
    maxRequestBytes: [0, 131073, 0.5],
    maxStateBytes: [0, 131073, Infinity],
    maxMemberships: [0, 10001, NaN],
    notificationConcurrency: [0, 101, 0.5],
  }))
    for (const value of values)
      await assert.rejects(
        createPgSubnetStatusHub(f.runtime, { ...f.options, [key]: value }),
        /Invalid subnet status/,
      );
  await assert.rejects(
    createPgSubnetStatusHub(f.runtime, { ...f.options, notify: null as never }),
    /notifier/,
  );
  await assert.rejects(
    createPgSubnetStatusHub(f.runtime, {
      ...f.options,
      onBackgroundError: null as never,
    }),
    /notifier/,
  );
  await assert.rejects(
    createPgSubnetStatusHub(f.runtime, { ...f.options, maxMemberships: 5 }),
    /policy differs/,
  );
  const options = { ...f.options };
  const hub = await createPgSubnetStatusHub(f.runtime, options);
  options.maxStateBytes = 1;
  options.notify = async () => {
    throw new Error("mutated");
  };
  await hub.fetch(request("/mcp-subscribe", { sessionId: "A", netuid: 7 }));
  assert.deepEqual(await state(), { byNetuid: { "7": ["A"] } });
  await hub.close();
});

test("matches the existing class's response and persisted membership across restarts", async () => {
  const stored = new Map<string, unknown>();
  const raw = new SubnetStatusHub(
    {
      storage: {
        get: async (keys) =>
          new Map(
            keys
              .filter((key) => stored.has(key))
              .map((key) => [key, stored.get(key)]),
          ),
        put: async (entries) => {
          for (const [key, value] of Object.entries(entries))
            stored.set(key, structuredClone(value));
        },
      },
      waitUntil: () => {},
    },
    {},
  );
  const cases: [string, unknown][] = [
    ["/mcp-subscribe", { sessionId: "A", netuid: 7 }],
    [
      "/mcp-subscribe",
      { sessionId: "A", netuid: "metagraph://subnet/7/status" },
    ],
    ["/mcp-subscribe", { sessionId: "B", netuid: 9 }],
    ["/mcp-subscribe", {}],
    ["/mcp-unsubscribe", {}],
    ["/mcp-unsubscribe", { sessionId: "A", netuid: 7 }],
    ["/mcp-subscribe", { sessionId: "A", netuid: 11 }],
    ["/mcp-unsubscribe-session", { sessionId: "A" }],
    ["/missing", {}],
  ];
  for (const [path, body] of cases) {
    const expected = await raw.fetch(request(path, body));
    const actual = await f.hub.fetch(request(path, body));
    assert.equal(actual.status, expected.status);
    assert.equal(await actual.text(), await expected.text());
    assert.deepEqual(await state(), Object.fromEntries(stored));
  }
  await f.hub.close();
  const restarted = await createPgSubnetStatusHub(f.runtime, f.options);
  await restarted.fetch(
    request("/mcp-subscribe", { sessionId: "C", netuid: 9 }),
  );
  assert.deepEqual(await state(), { byNetuid: { "9": ["B", "C"] } });
  await restarted.close();
});

test("serializes competing membership writers without losing entries", async () => {
  const peer = await createPgSubnetStatusHub(f.runtime, f.options);
  await Promise.all([
    f.hub.fetch(request("/mcp-subscribe", { sessionId: "A", netuid: 7 })),
    peer.fetch(request("/mcp-subscribe", { sessionId: "B", netuid: 7 })),
  ]);
  assert.deepEqual(await state(), { byNetuid: { "7": ["A", "B"] } });
  await peer.close();
});

test("bounded notifications use a finished snapshot and release the database before sending", async () => {
  let peak = 0,
    active = 0,
    calls = 0;
  const entered = queueDeferred(),
    release = queueDeferred();
  f = await subnetStatusFixture(db, {
    ...subnetStatusOptions,
    notify: async () => {
      assert.equal(f.activeTransactions(), 0);
      active++;
      peak = Math.max(peak, active);
      calls++;
      if (calls === 2) entered.resolve();
      await release.promise;
      active--;
    },
  });
  for (const sessionId of ["A", "B", "C", "D", "E"])
    await f.hub.fetch(request("/mcp-subscribe", { sessionId, netuid: 7 }));
  const sending = f.hub.fetch(
    request("/notify-changed", { netuids: [7, 7, "bad"] }),
  );
  await entered.promise;
  const writer = await createPgSubnetStatusHub(f.runtime, f.options);
  await writer.fetch(
    request("/mcp-subscribe", { sessionId: "later", netuid: 7 }),
  );
  assert.equal(calls, 2);
  release.resolve();
  assert.deepEqual(await (await sending).json(), { ok: true, delivered: 5 });
  assert.equal(calls, 5);
  assert.equal(peak, 2);
  assert.deepEqual(await state(), {
    byNetuid: { "7": ["A", "B", "C", "D", "E", "later"] },
  });
  await writer.close();
});

test("completed missing-session responses retain the original counting while rejected calls do not", async () => {
  f = await subnetStatusFixture(db, {
    ...subnetStatusOptions,
    notify: async (session) => {
      if (session === "bad") throw new Error("unavailable");
      return new Response("not found", { status: 404 });
    },
  });
  for (const sessionId of ["bad", "missing"])
    await f.hub.fetch(request("/mcp-subscribe", { sessionId, netuid: 7 }));
  assert.deepEqual(
    await (
      await f.hub.fetch(request("/notify-changed", { netuids: [7] }))
    ).json(),
    { ok: true, delivered: 1 },
  );
  assert.deepEqual(
    await (
      await f.hub.fetch(request("/notify-changed", { netuids: [] }))
    ).json(),
    { ok: true, delivered: 0 },
  );
});

test("state/membership overflow rolls back without poisoning a later valid request", async () => {
  f = await subnetStatusFixture(db, {
    ...subnetStatusOptions,
    maxMemberships: 1,
  });
  await f.hub.fetch(request("/mcp-subscribe", { sessionId: "A", netuid: 7 }));
  await assert.rejects(
    f.hub.fetch(request("/mcp-subscribe", { sessionId: "B", netuid: 7 })),
    /capacity/,
  );
  assert.deepEqual(await state(), { byNetuid: { "7": ["A"] } });
  await f.hub.fetch(request("/mcp-unsubscribe-session", { sessionId: "A" }));
  await f.hub.fetch(request("/mcp-subscribe", { sessionId: "B", netuid: 7 }));
  f = await subnetStatusFixture(db, {
    ...subnetStatusOptions,
    maxStateBytes: 20,
  });
  await assert.rejects(
    f.hub.fetch(request("/mcp-subscribe", { sessionId: "A", netuid: 7 })),
    /byte limit/,
  );
  assert.deepEqual(await state(), {});
});

test("body bounds and pre-aborted streams are handled before acquiring membership storage", async () => {
  f = await subnetStatusFixture(db, {
    ...subnetStatusOptions,
    maxRequestBytes: 4,
  });
  await assert.rejects(
    f.hub.fetch(request("/mcp-subscribe", { sessionId: "A", netuid: 7 })),
    /request exceeds/,
  );
  assert.deepEqual(await state(), {});
  const controller = new AbortController();
  controller.abort(new Error("gone"));
  await assert.rejects(
    f.hub.fetch(request("/mcp-subscribe", {}, controller.signal)),
    /gone/,
  );
  assert.equal(f.activeTransactions(), 0);
  const response = await f.hub.fetch(
    new Request("https://subnet-status.invalid/missing"),
  );
  assert.equal(response.status, 404);
});

test("drain preserves uncooperative notification lifetime while the pool remains free", async () => {
  f = await subnetStatusFixture(db, {
    ...subnetStatusOptions,
    maxConcurrentRequests: 1,
    executionTimeoutMillis: 20,
    drainTimeoutMillis: 10,
    notify: async () => {
      entered.resolve();
      await release.promise;
    },
  });
  const entered = queueDeferred(),
    release = queueDeferred();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    await f.hub.fetch(request("/mcp-subscribe", { sessionId: "A", netuid: 7 }));
    const pending = assert.rejects(
      f.hub.fetch(request("/notify-changed", { netuids: [7] })),
      /execution deadline/,
    );
    await entered.promise;
    await vi.advanceTimersByTimeAsync(20);
    await pending;
    assert.equal(f.activeTransactions(), 0);
    await assert.rejects(f.hub.fetch(request("/missing", {})), /capacity/);
    const close = assert.rejects(f.hub.close(), /drain deadline/);
    await vi.advanceTimersByTimeAsync(10);
    await close;
    assert.equal(f.hub.state, "closing");
    release.resolve();
    await f.hub.close();
    assert.equal(f.hub.state, "closed");
    await assert.rejects(f.hub.fetch(request("/missing", {})), /closed/);
  } finally {
    vi.useRealTimers();
  }
});

test("cancels a stalled request body before entering a database transaction", async () => {
  let cancelled = false;
  const abort = new AbortController();
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    signal: abort.signal,
    duplex: "half",
    body: new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    }),
  };
  const pending = f.hub.fetch(
    new Request("https://subnet-status.invalid/mcp-subscribe", init),
  );
  await Promise.resolve();
  await Promise.resolve();
  abort.abort(new Error("body disconnected"));
  await assert.rejects(pending, /body disconnected/);
  assert.equal(cancelled, true);
  assert.equal(f.activeTransactions(), 0);
  assert.deepEqual(await state(), {});
});

test("notification snapshots reject mutation and do not retain background failures as successful work", async () => {
  const original = SubnetStatusHub.prototype.handleNotifyChanged;
  try {
    SubnetStatusHub.prototype.handleNotifyChanged = async function () {
      await this.state.storage.put({ byNetuid: { "7": ["changed"] } });
      return new Response("unexpected");
    };
    await assert.rejects(
      f.hub.fetch(request("/notify-changed", { netuids: [7] })),
      /snapshot cannot mutate/,
    );
    assert.deepEqual(await state(), {});
  } finally {
    SubnetStatusHub.prototype.handleNotifyChanged = original;
  }
});

test("background work drains outside the membership transaction and reporter failures stay secondary", async () => {
  const original = SubnetStatusHub.prototype.fetch;
  const errors: unknown[] = [];
  f = await subnetStatusFixture(db, {
    ...subnetStatusOptions,
    onBackgroundError: (error) => {
      errors.push(error);
      throw new Error("reporter failed");
    },
  });
  try {
    SubnetStatusHub.prototype.fetch = async function () {
      this.state.waitUntil(Promise.reject(new Error("background failure")));
      return new Response("preserved");
    };
    assert.equal(
      await (await f.hub.fetch(request("/anything", {}))).text(),
      "preserved",
    );
    assert.equal(errors.length, 1);
  } finally {
    SubnetStatusHub.prototype.fetch = original;
  }
});

test("a disappeared state row or malformed stored envelope is refused", async () => {
  await db.exec("DELETE FROM realtime.subnet_status_actor");
  await assert.rejects(f.hub.fetch(request("/missing", {})), /policy differs/);
  for (const value of [null, [], "invalid", "null", "[]"]) {
    const runtime: Parameters<typeof createPgSubnetStatusHub>[0] = {
      transaction: async (callback) =>
        callback({
          query: async () => [],
          first: async <Row>() =>
            ({
              state: value,
              max_state_bytes: 131072,
              max_memberships: 1000,
            }) as Row,
          run: async () => ({ changes: 1 }),
        }),
    };
    await assert.rejects(
      createPgSubnetStatusHub(runtime, subnetStatusOptions),
      /Invalid subnet status state/,
    );
  }
});

test("empty body chunks cannot grow buffering or postpone its finite read bound", async () => {
  f = await subnetStatusFixture(db, {
    ...subnetStatusOptions,
    maxRequestBytes: 4,
  });
  let cancelled = false;
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    duplex: "half",
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array());
      },
      cancel() {
        cancelled = true;
      },
    }),
  };
  await assert.rejects(
    f.hub.fetch(
      new Request("https://subnet-status.invalid/mcp-subscribe", init),
    ),
    /chunk limit/,
  );
  assert.equal(cancelled, true);
  assert.deepEqual(await state(), {});
});

test("reader cancellation failures do not replace a body error or disconnect", async () => {
  const failedInit: RequestInit & { duplex: "half" } = {
    method: "POST",
    duplex: "half",
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("body failed"));
      },
    }),
  };
  await assert.rejects(
    f.hub.fetch(
      new Request("https://subnet-status.invalid/mcp-subscribe", failedInit),
    ),
    /body failed/,
  );
  const abort = new AbortController();
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    duplex: "half",
    signal: abort.signal,
    body: new ReadableStream<Uint8Array>({
      cancel() {
        return Promise.reject(new Error("cancel failed"));
      },
    }),
  };
  const pending = f.hub.fetch(
    new Request("https://subnet-status.invalid/mcp-subscribe", init),
  );
  await Promise.resolve();
  await Promise.resolve();
  abort.abort(new Error("body disconnected"));
  await assert.rejects(pending, /body disconnected/);
  assert.deepEqual(await state(), {});
});

test("preserves the existing actor's NUL and lone-surrogate session IDs as exact JSON text", async () => {
  const ids = ["nul\u0000session", "lone\ud800session", "low\udc00session"];
  const stored = new Map<string, unknown>();
  const raw = new SubnetStatusHub(
    {
      storage: {
        get: async (keys) =>
          new Map(
            keys
              .filter((key) => stored.has(key))
              .map((key) => [key, stored.get(key)]),
          ),
        put: async (entries) => {
          for (const [key, value] of Object.entries(entries))
            stored.set(key, structuredClone(value));
        },
      },
      waitUntil: () => {},
    },
    {},
  );
  for (const sessionId of ids) {
    const expected = await raw.fetch(
      request("/mcp-subscribe", { sessionId, netuid: 7 }),
    );
    const response = await f.hub.fetch(
      request("/mcp-subscribe", { sessionId, netuid: 7 }),
    );
    assert.equal(response.status, expected.status);
    assert.equal(await response.text(), await expected.text());
  }
  const text = (
    await db.query<{ state: string }>(
      "SELECT state FROM realtime.subnet_status_actor",
    )
  ).rows[0]!.state;
  assert.equal(text, JSON.stringify(Object.fromEntries(stored)));
  await f.hub.close();
  const received: string[] = [];
  const restarted = await createPgSubnetStatusHub(f.runtime, {
    ...f.options,
    notify: async (id) => {
      received.push(id);
    },
  });
  await restarted.fetch(request("/notify-changed", { netuids: [7] }));
  assert.deepEqual(received.sort(), [...ids].sort());
  await restarted.close();
});
