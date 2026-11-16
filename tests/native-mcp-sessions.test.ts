import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, test, vi } from "vitest";
import {
  createNativeMcpSessions,
  type NativeMcpSessionOptions,
} from "../src/native-mcp-sessions.ts";
import {
  formatMcpSseEvent,
  buildResourceUpdatedNotification,
  McpSessionHub,
} from "../workers/mcp-session-hub.ts";
import { mcpFixture, mcpLimits } from "./helpers/mcp-session-fixture.ts";
import { queueDeferred } from "./helpers/queue-fixture.ts";
import type { PgTransactionRunner } from "../src/pg-pool.ts";

let db: PGlite;
let f: Awaited<ReturnType<typeof mcpFixture>>;
const services: Awaited<ReturnType<typeof createNativeMcpSessions>>[] = [];
const ok = {
  fetch: async () =>
    new Response('{"ok":true}', {
      headers: { "content-type": "application/json" },
    }),
};
const options: NativeMcpSessionOptions = {
  ...mcpLimits,
  maxResidentSessions: 4,
  maxConcurrentCalls: 8,
  maxPendingCallsPerSession: 4,
  maxRequestBytes: 8192,
  maxQueuedFrames: 4,
  renewIntervalMillis: 10000,
  residentIdleMillis: 5000,
  executionTimeoutMillis: 20000,
  drainTimeoutMillis: 1000,
  subnetStatus: ok,
  chainFirehose: ok,
  onBackgroundError: () => {},
};
const uri = "metagraph://subnet/7/status";
const request = (path: string, body?: unknown, signal?: AbortSignal) =>
  new Request(
    `https://mcp-session.invalid${path}`,
    body === undefined
      ? { signal }
      : { method: "POST", body: JSON.stringify(body), signal },
  );
const peer = async (
  overrides: Partial<NativeMcpSessionOptions> = {},
  runtime = f.runtime,
) => {
  const service = await createNativeMcpSessions(runtime, {
    ...options,
    ...overrides,
  });
  services.push(service);
  return service;
};
const register = async (
  service: Awaited<ReturnType<typeof peer>>,
  id = "A",
) => {
  assert.equal(
    (await service.fetch(id, request("/register", { sessionId: id }))).status,
    200,
  );
};
const subscribe = async (
  service: Awaited<ReturnType<typeof peer>>,
  id = "A",
) => {
  assert.equal(
    (await service.fetch(id, request("/subscribe", { sessionId: id, uri })))
      .status,
    200,
  );
};
const stored = async (id = "A") =>
  (
    await db.query<{
      state: string;
      alarm_at_ms: string | null;
      alarm_outcome: string;
      owner_token: string | null;
    }>("SELECT * FROM realtime.mcp_sessions WHERE session_key=$1", [
      JSON.stringify(id),
    ])
  ).rows[0]!;
const flush = async () => {
  await db.query("SELECT 1");
  await Promise.resolve();
  await Promise.resolve();
};
beforeAll(() => {
  db = new PGlite();
});
beforeEach(async () => {
  f = await mcpFixture(db);
});
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  vi.restoreAllMocks();
  vi.useRealTimers();
});
afterAll(async () => {
  await db.close();
});

test("requires bounded residency, call and lease controls with explicit reverse owners", async () => {
  for (const [name, values] of Object.entries({
    maxResidentSessions: [0, 10001, NaN],
    maxConcurrentCalls: [0, 101, 0.5],
    maxPendingCallsPerSession: [0, 101, NaN],
    maxRequestBytes: [0, 131073, NaN],
    maxQueuedFrames: [0, 1025, 0.5],
    renewIntervalMillis: [0, 3600001, NaN],
    residentIdleMillis: [0, 3600001, NaN],
  }))
    for (const value of values)
      await assert.rejects(
        createNativeMcpSessions(f.runtime, { ...options, [name]: value }),
        /Invalid MCP/,
      );
  await assert.rejects(
    createNativeMcpSessions(f.runtime, {
      ...options,
      renewIntervalMillis: 20000,
    }),
    /headroom/,
  );
  await assert.rejects(
    createNativeMcpSessions(f.runtime, {
      ...options,
      executionTimeoutMillis: 60000,
    }),
    /headroom/,
  );
  for (const name of [
    "subnetStatus",
    "chainFirehose",
    "onBackgroundError",
  ] as const)
    await assert.rejects(
      createNativeMcpSessions(f.runtime, { ...options, [name]: null }),
      /required/,
    );
});

test("one resident instance serves subscriptions and exact SSE notifications without a retained connection", async () => {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "performance",
    ],
  });
  const service = await peer();
  assert.equal(service.state, "ready");
  await register(service);
  await subscribe(service);
  const response = await service.fetch("A", request("/stream?sessionId=A"));
  assert.equal(response.status, 200);
  assert.equal(f.activeTransactions(), 0);
  const reader = response.body!.getReader();
  const pending = reader.read();
  assert.equal(
    (await service.fetch("A", request("/notify", { uri }))).status,
    200,
  );
  assert.equal(
    new TextDecoder().decode((await pending).value),
    formatMcpSseEvent(1, buildResourceUpdatedNotification(uri)),
  );
  assert.equal(JSON.parse((await stored()).state).sequence, 1);
  assert.equal(service.residentCount, 1);
  assert.equal(f.activeTransactions(), 0);
  await reader.cancel();
  assert.equal(
    (await service.fetch("A", request("/terminate", { sessionId: "A" })))
      .status,
    200,
  );
  assert.equal(JSON.parse((await stored()).state).terminated, true);
});

test("pending notifications and their sequence survive resident shutdown and reconstruction", async () => {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "performance",
    ],
  });
  const service = await peer();
  await register(service);
  await subscribe(service);
  await service.fetch("A", request("/notify", { uri }));
  assert.deepEqual(JSON.parse((await stored()).state).pendingUris, [uri]);
  await service.close();
  const restarted = await peer();
  const stream = await restarted.fetch("A", request("/stream?sessionId=A"));
  const reader = stream.body!.getReader();
  assert.equal(
    new TextDecoder().decode((await reader.read()).value),
    formatMcpSseEvent(1, buildResourceUpdatedNotification(uri)),
  );
  const state = JSON.parse((await stored()).state);
  assert.equal(state.sequence, 1);
  assert.deepEqual(state.pendingUris, [uri]);
  await reader.cancel();
});

test("a newer stream takes over without an old client's cancellation clearing it", async () => {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "performance",
    ],
  });
  const service = await peer();
  await register(service);
  await subscribe(service);
  const first = await service.fetch("A", request("/stream?sessionId=A"));
  const old = first.body!.getReader();
  const second = await service.fetch("A", request("/stream?sessionId=A"));
  const current = second.body!.getReader();
  await old.cancel();
  await service.fetch("A", request("/notify", { uri }));
  assert.equal((await current.read()).done, false);
  await current.cancel();
});

test("closed clients leave no live stream and future notifications are durably pending", async () => {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "performance",
    ],
  });
  const service = await peer();
  await register(service);
  await subscribe(service);
  const abort = new AbortController();
  const response = await service.fetch(
    "A",
    request("/stream?sessionId=A", undefined, abort.signal),
  );
  const reader = response.body!.getReader();
  const pending = reader.read();
  abort.abort(new Error("disconnected"));
  assert.equal((await pending).done, true);
  await service.fetch("A", request("/notify", { uri }));
  assert.deepEqual(JSON.parse((await stored()).state).pendingUris, [uri]);
});

test("native stream buffering closes a stalled stream and preserves the undelivered pointer", async () => {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "performance",
    ],
  });
  const service = await peer({ maxQueuedFrames: 1 });
  await register(service);
  await subscribe(service);
  const stream = await service.fetch("A", request("/stream?sessionId=A"));
  for (let index = 0; index < 5; index++)
    await service.fetch("A", request("/notify", { uri }));
  assert.deepEqual(JSON.parse((await stored()).state).pendingUris, [uri]);
  const next = await service.fetch("A", request("/stream?sessionId=A"));
  const reader = next.body!.getReader();
  assert.equal((await reader.read()).done, false);
  await reader.cancel();
  await stream.body!.cancel();
});

test("paused timers cannot send after the conservative monotonic ownership deadline", async () => {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "performance",
    ],
  });
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  let heartbeat: (() => void) | undefined;
  const setInterval = globalThis.setInterval;
  vi.spyOn(globalThis, "setInterval").mockImplementation(((
    callback: () => void,
    ms: number,
  ) => {
    heartbeat = callback;
    return setInterval(callback, ms);
  }) as typeof setInterval);
  const first = await peer();
  await register(first);
  const response = await first.fetch("A", request("/stream?sessionId=A"));
  const reader = response.body!.getReader();
  const pending = reader.read();
  now = 60001;
  heartbeat!();
  assert.equal((await pending).done, true);
  assert.equal(first.residentCount, 0);
  await db.exec("UPDATE realtime.mcp_sessions SET lease_until_ms=0");
  const second = await peer();
  await register(second);
  assert.equal(second.residentCount, 1);
  await assert.rejects(
    first.fetch("A", request("/notify", { uri })),
    /another process/,
  );
});

test("renewal failure closes the stream and does not keep a process-owned connection", async () => {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "performance",
    ],
  });
  const service = await peer();
  await register(service);
  const response = await service.fetch("A", request("/stream?sessionId=A"));
  const reader = response.body!.getReader();
  const pending = reader.read();
  await db.exec("UPDATE realtime.mcp_sessions SET lease_until_ms=0");
  await vi.advanceTimersByTimeAsync(10000);
  await flush();
  assert.equal((await pending).done, true);
  assert.equal(service.residentCount, 0);
  assert.equal(f.activeTransactions(), 0);
});

test("a late successful renewal cannot revive an expired resident", async () => {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "performance",
    ],
  });
  const gate = queueDeferred(),
    entered = queueDeferred();
  let delay = false;
  const transaction: PgTransactionRunner = async (callback) => {
    let renewal = false;
    const result = await f.runtime.transaction((tx) =>
      callback({
        ...tx,
        run: async (text, values) => {
          if (
            text.startsWith("UPDATE realtime.mcp_sessions SET lease_until_ms=")
          )
            renewal = true;
          return tx.run(text, values);
        },
      }),
    );
    if (renewal && delay) {
      entered.resolve();
      await gate.promise;
    }
    return result;
  };
  const service = await peer(
    { residentIdleMillis: 120000 },
    { ...f.runtime, transaction },
  );
  await register(service);
  const response = await service.fetch("A", request("/stream?sessionId=A"));
  const reader = response.body!.getReader();
  const pending = reader.read();
  delay = true;
  try {
    await vi.advanceTimersByTimeAsync(10000);
    await entered.promise;
    await vi.advanceTimersByTimeAsync(20000);
    assert.equal((await pending).done, false);
    const closed = reader.read();
    await vi.advanceTimersByTimeAsync(30001);
    assert.equal((await closed).done, true);
  } finally {
    gate.resolve();
  }
  await flush();
  assert.equal(service.residentCount, 0);
});

test("idle residency is finite while durable session state remains available", async () => {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "performance",
    ],
  });
  const service = await peer({ maxResidentSessions: 1 });
  await register(service, "A");
  await assert.rejects(register(service, "B"), /resident capacity/);
  await vi.advanceTimersByTimeAsync(5000);
  await flush();
  assert.equal(service.residentCount, 0);
  await register(service, "B");
  assert.equal(JSON.parse((await stored("A")).state).sessionId, "A");
});

test("specific idle alarms terminate sessions and preserve failed reverse cleanup re-arming", async () => {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "performance",
    ],
  });
  let fail = true;
  const service = await peer({
    subnetStatus: {
      fetch: async (req) => {
        if (new URL(req.url).pathname === "/mcp-unsubscribe-session" && fail)
          throw new Error("reverse cleanup unavailable");
        return new Response('{"ok":true}');
      },
    },
  });
  await register(service);
  await subscribe(service);
  await db.exec("UPDATE realtime.mcp_sessions SET alarm_at_ms=0");
  assert.deepEqual(await service.runDueAlarms(10), {
    completed: 0,
    rearmed: 1,
    skipped: 0,
    failed: 0,
  });
  assert.equal((await stored()).alarm_outcome, "pending");
  assert.ok(Number((await stored()).alarm_at_ms) > Date.now() + 250000);
  fail = false;
  await db.exec("UPDATE realtime.mcp_sessions SET alarm_at_ms=0");
  assert.deepEqual(await service.runDueAlarms(10), {
    completed: 1,
    rearmed: 0,
    skipped: 0,
    failed: 0,
  });
  assert.equal(JSON.parse((await stored()).state).terminated, true);
});

test("unknown read-only sessions leave no permanent empty row and closed services reject admission", async () => {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "performance",
    ],
  });
  const service = await peer();
  assert.equal(
    (await service.fetch("missing", request("/stream?sessionId=missing")))
      .status,
    404,
  );
  assert.equal(service.residentCount, 0);
  await service.close();
  assert.equal(
    (await db.query("SELECT * FROM realtime.mcp_sessions")).rows.length,
    0,
  );
  assert.equal(service.state, "closed");
  await assert.rejects(
    service.fetch("A", request("/register", { sessionId: "A" })),
    /closed/,
  );
  await assert.rejects(service.runDueAlarms(1), /closed/);
});

test("concurrent calls share one resident and reject excess queued work without discarding accepted calls", async () => {
  const entered = queueDeferred(),
    gate = queueDeferred();
  const original = McpSessionHub.prototype.fetch;
  let calls = 0;
  vi.spyOn(McpSessionHub.prototype, "fetch").mockImplementation(async function (
    this: McpSessionHub,
    request,
  ) {
    if (++calls === 1) {
      entered.resolve();
      await gate.promise;
    }
    return original.call(this, request);
  });
  const service = await peer({ maxPendingCallsPerSession: 2 });
  const first = register(service);
  await entered.promise;
  const second = register(service);
  try {
    await assert.rejects(register(service), /call capacity/);
  } finally {
    gate.resolve();
  }
  await Promise.all([first, second]);
  assert.equal(service.residentCount, 1);
  assert.equal(calls, 2);
  assert.equal(f.activeTransactions(), 0);
});

test("request limits and pre-cancellation reject input before creating a resident", async () => {
  const service = await peer({ maxRequestBytes: 4 });
  await assert.rejects(
    service.fetch("A", request("/register", { sessionId: "A" })),
    /byte limit/,
  );
  const abort = new AbortController();
  abort.abort(new Error("client gone"));
  await assert.rejects(
    service.fetch("A", request("/stream", undefined, abort.signal)),
    /client gone/,
  );
  assert.equal(service.residentCount, 0);
  assert.equal(
    (await db.query("SELECT * FROM realtime.mcp_sessions")).rows.length,
    0,
  );
});

test("alarm callback failures retain durable retries and reporter failures remain secondary", async () => {
  const reported: unknown[] = [];
  const service = await peer({
    onBackgroundError: (error) => {
      reported.push(error);
      throw new Error("reporting unavailable");
    },
  });
  await register(service);
  await db.exec("UPDATE realtime.mcp_sessions SET alarm_at_ms=0");
  const fault = new Error("callback unavailable");
  vi.spyOn(McpSessionHub.prototype, "alarm").mockRejectedValue(fault);
  assert.deepEqual(await service.runDueAlarms(1), {
    completed: 0,
    rearmed: 0,
    skipped: 0,
    failed: 1,
  });
  assert.equal((await stored()).alarm_outcome, "retry");
  assert.ok(Number((await stored()).alarm_at_ms) > Date.now());
  assert.deepEqual(reported, [fault]);
});

test("failed persistence closes a live stream and preserves its last durable sequence", async () => {
  const service = await peer();
  await register(service);
  await subscribe(service);
  const response = await service.fetch("A", request("/stream?sessionId=A"));
  const reader = response.body!.getReader();
  await db.exec("UPDATE realtime.mcp_sessions SET lease_until_ms=0");
  await assert.rejects(
    service.fetch("A", request("/notify", { uri })),
    /ownership/,
  );
  assert.equal(service.residentCount, 0);
  assert.equal(JSON.parse((await stored()).state).sequence, 0);
  assert.equal((await reader.read()).done, true);
  assert.equal(f.activeTransactions(), 0);
});

test("notification bytes wait for committed state and retain a restart marker even on a live stream", async () => {
  const entered = queueDeferred(),
    gate = queueDeferred();
  let delay = false;
  const transaction: PgTransactionRunner = async (callback) => {
    let saved = false;
    const result = await f.runtime.transaction((tx) =>
      callback({
        ...tx,
        run: async (text, values) => {
          if (text.startsWith("UPDATE realtime.mcp_sessions SET state="))
            saved = true;
          return tx.run(text, values);
        },
      }),
    );
    if (saved && delay) {
      entered.resolve();
      await gate.promise;
    }
    return result;
  };
  const service = await peer({}, { ...f.runtime, transaction });
  await register(service);
  await subscribe(service);
  const stream = await service.fetch("A", request("/stream?sessionId=A"));
  const reader = stream.body!.getReader();
  let delivered = false;
  const frame = reader.read().then((value) => {
    delivered = true;
    return value;
  });
  delay = true;
  const notify = service.fetch("A", request("/notify", { uri }));
  try {
    await entered.promise;
    await Promise.resolve();
    assert.equal(delivered, false);
    assert.equal(f.activeTransactions(), 0);
  } finally {
    gate.resolve();
  }
  await notify;
  assert.equal(
    new TextDecoder().decode((await frame).value),
    formatMcpSseEvent(1, buildResourceUpdatedNotification(uri)),
  );
  assert.deepEqual(JSON.parse((await stored()).state).pendingUris, [uri]);
  await reader.cancel();
  await service.close();
  const restarted = await peer();
  const replay = await restarted.fetch("A", request("/stream?sessionId=A"));
  const replayReader = replay.body!.getReader();
  assert.equal(
    new TextDecoder().decode((await replayReader.read()).value),
    formatMcpSseEvent(2, buildResourceUpdatedNotification(uri)),
  );
  await replayReader.cancel();
});

test("disconnect after a sequence commit and before enqueue leaves a replayable notification", async () => {
  const entered = queueDeferred(),
    gate = queueDeferred();
  let delay = false;
  const transaction: PgTransactionRunner = async (callback) => {
    let saved = false;
    const result = await f.runtime.transaction((tx) =>
      callback({
        ...tx,
        run: async (text, values) => {
          if (text.startsWith("UPDATE realtime.mcp_sessions SET state="))
            saved = true;
          return tx.run(text, values);
        },
      }),
    );
    if (saved && delay) {
      entered.resolve();
      await gate.promise;
    }
    return result;
  };
  const service = await peer({}, { ...f.runtime, transaction });
  await register(service);
  await subscribe(service);
  const abort = new AbortController();
  const stream = await service.fetch(
    "A",
    request("/stream?sessionId=A", undefined, abort.signal),
  );
  const reader = stream.body!.getReader();
  const frame = reader.read();
  delay = true;
  const notify = service.fetch("A", request("/notify", { uri }));
  try {
    await entered.promise;
    assert.equal(JSON.parse((await stored()).state).sequence, 1);
    abort.abort(new Error("client disconnected after commit"));
    assert.equal((await frame).done, true);
  } finally {
    gate.resolve();
  }
  await notify;
  await service.close();
  const restarted = await peer();
  const replay = await restarted.fetch("A", request("/stream?sessionId=A"));
  const replayReader = replay.body!.getReader();
  assert.equal(
    new TextDecoder().decode((await replayReader.read()).value),
    formatMcpSseEvent(2, buildResourceUpdatedNotification(uri)),
  );
  await replayReader.cancel();
});

test("successful renewal extends custody while stale timer callbacks do nothing after shutdown", async () => {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "performance",
    ],
  });
  const timers = new Map<number, (() => void)[]>();
  const schedule = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: () => void,
    delay: number,
  ) => {
    timers.set(delay, [...(timers.get(delay) ?? []), callback]);
    return schedule(callback, delay);
  }) as typeof setTimeout);
  const service = await peer();
  await register(service);
  const stream = await service.fetch("A", request("/stream?sessionId=A"));
  await vi.advanceTimersByTimeAsync(10000);
  await flush();
  assert.equal(service.residentCount, 1);
  assert.ok(
    (timers.get(10000)?.length ?? 0) >= 2,
    "successful renewal schedules the next renewal",
  );
  const staleRenew = timers.get(10000)![0],
    staleIdle = timers.get(5000)![0];
  await service.close();
  staleRenew();
  staleIdle();
  assert.equal((await stored()).owner_token, null);
  await stream.body!.cancel();
});

test("concurrent acquisition shares custody and shutdown releases a late acquired lease", async () => {
  const entered = queueDeferred(),
    gate = queueDeferred();
  let acquires = 0;
  const transaction: PgTransactionRunner = async (callback) => {
    let acquired = false;
    const result = await f.runtime.transaction((tx) =>
      callback({
        ...tx,
        run: async (text, values) => {
          if (
            text.startsWith("UPDATE realtime.mcp_sessions SET owner_process=?,")
          ) {
            acquired = true;
            acquires++;
          }
          return tx.run(text, values);
        },
      }),
    );
    if (acquired) {
      entered.resolve();
      await gate.promise;
    }
    return result;
  };
  const service = await peer({}, { ...f.runtime, transaction });
  const first = register(service),
    second = register(service);
  const firstRejected = assert.rejects(first, /closed/),
    secondRejected = assert.rejects(second, /closed/);
  await entered.promise;
  const closed = service.close();
  gate.resolve();
  await Promise.all([firstRejected, secondRejected, closed]);
  assert.equal(acquires, 1);
  assert.equal((await stored()).owner_token, null);
});

test("a lease acquired after its safe roundtrip budget is released without admitting a resident", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const transaction: PgTransactionRunner = async (callback) => {
    let acquired = false;
    const result = await f.runtime.transaction((tx) =>
      callback({
        ...tx,
        run: async (text, values) => {
          if (
            text.startsWith("UPDATE realtime.mcp_sessions SET owner_process=?,")
          )
            acquired = true;
          return tx.run(text, values);
        },
      }),
    );
    if (acquired) now = 60001;
    return result;
  };
  const service = await peer({}, { ...f.runtime, transaction });
  await assert.rejects(register(service), /safe deadline/);
  assert.equal(service.residentCount, 0);
  assert.equal((await stored()).owner_token, null);
});

test("background work drains without a connection and persists Date alarms before returning", async () => {
  const entered = queueDeferred(),
    gate = queueDeferred();
  const errors: unknown[] = [];
  const service = await peer({
    onBackgroundError: (error) => errors.push(error),
  });
  await register(service);
  vi.spyOn(McpSessionHub.prototype, "fetch").mockImplementation(async function (
    this: McpSessionHub,
  ) {
    await this.state.storage.setAlarm(new Date(12345));
    this.state.waitUntil(gate.promise);
    this.state.waitUntil(Promise.reject(new Error("background failure")));
    entered.resolve();
    return new Response("drained");
  });
  const pending = service.fetch("A", request("/background"));
  await entered.promise;
  assert.equal(f.activeTransactions(), 0);
  gate.resolve();
  assert.equal(await (await pending).text(), "drained");
  assert.equal(Number((await stored()).alarm_at_ms), 12345);
  assert.equal(errors.length, 1);
});

test("issued storage failures and handler failures retire the resident without accepting later work", async () => {
  const service = await peer();
  await register(service);
  const fetch = vi
    .spyOn(McpSessionHub.prototype, "fetch")
    .mockImplementation(async function (this: McpSessionHub) {
      void this.state.storage.put({ sequence: "invalid" }).catch(() => {});
      return new Response("must fail");
    });
  await assert.rejects(
    service.fetch("A", request("/invalid")),
    /Invalid native MCP session state/,
  );
  assert.equal(service.residentCount, 0);
  fetch.mockRestore();
  await db.exec("UPDATE realtime.mcp_sessions SET lease_until_ms=0");
  await register(service);
  vi.spyOn(McpSessionHub.prototype, "fetch").mockImplementation(async () => {
    throw new Error("handler failure");
  });
  await assert.rejects(
    service.fetch("A", request("/invalid")),
    /handler failure/,
  );
});

test("native streams propagate normal completion, read failures and cancellation failures", async () => {
  const service = await peer();
  await register(service);
  const fetch = vi.spyOn(McpSessionHub.prototype, "fetch");
  fetch.mockResolvedValue(
    new Response(null, { headers: { "content-type": "text/event-stream" } }),
  );
  assert.equal((await service.fetch("A", request("/bodyless"))).body, null);
  for (const failure of [false, true]) {
    fetch.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            if (failure) controller.error(new Error("source read failed"));
            else controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
    const response = await service.fetch("A", request("/stream"));
    if (failure) await assert.rejects(response.text(), /source read failed/);
    else assert.equal(await response.text(), "");
  }
  fetch.mockResolvedValue(
    new Response(
      new ReadableStream({
        cancel() {
          return Promise.reject(new Error("source cancel failed"));
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    ),
  );
  await (await service.fetch("A", request("/stream"))).body!.cancel();
});

test("the bridge rejects a frame when ownership expires while its source read is pending", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const service = await peer();
  await register(service);
  let source!: ReadableStreamDefaultController<Uint8Array>;
  vi.spyOn(McpSessionHub.prototype, "fetch").mockResolvedValue(
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          source = controller;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    ),
  );
  const response = await service.fetch("A", request("/stream"));
  const pending = response.body!.getReader().read();
  now = 60001;
  source.enqueue(new TextEncoder().encode("data: expired\n\n"));
  assert.equal((await pending).done, true);
  assert.equal(service.residentCount, 0);
});

test("global call admission stays bounded while one accepted handler is stalled", async () => {
  const entered = queueDeferred(),
    gate = queueDeferred();
  const service = await peer({ maxConcurrentCalls: 1 });
  await register(service);
  const original = McpSessionHub.prototype.fetch;
  vi.spyOn(McpSessionHub.prototype, "fetch").mockImplementation(async function (
    this: McpSessionHub,
    request,
  ) {
    entered.resolve();
    await gate.promise;
    return original.call(this, request);
  });
  const first = register(service);
  await entered.promise;
  try {
    await assert.rejects(register(service, "B"), /call capacity/);
    await db.exec("UPDATE realtime.mcp_sessions SET alarm_at_ms=0");
    assert.deepEqual(await service.runDueAlarms(1), {
      completed: 0,
      rearmed: 0,
      skipped: 0,
      failed: 1,
    });
  } finally {
    gate.resolve();
  }
  await first;
  assert.equal(service.residentCount, 1);
});

test("uncooperative handlers keep shutdown visibly closing until they actually finish", async () => {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "performance",
    ],
  });
  const entered = queueDeferred(),
    gate = queueDeferred();
  const service = await peer({
    drainTimeoutMillis: 100,
    executionTimeoutMillis: 1000,
  });
  await register(service);
  vi.spyOn(McpSessionHub.prototype, "fetch").mockImplementation(async () => {
    entered.resolve();
    await gate.promise;
    return new Response("late");
  });
  const pending = service.fetch("A", request("/blocked"));
  const rejected = assert.rejects(pending, /drain deadline/);
  await entered.promise;
  const close = service.close();
  const closeRejected = assert.rejects(close, /drain deadline/);
  try {
    assert.equal(service.state, "closing");
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all([rejected, closeRejected]);
    assert.equal(service.state, "closing");
  } finally {
    gate.resolve();
  }
  await flush();
  await service.close();
  assert.equal(service.state, "closed");
});

test("alarm claims skip canceled work and refuse settlement after their token is replaced", async () => {
  const transaction: PgTransactionRunner = async (callback) => {
    let scanned = false;
    const result = await f.runtime.transaction((tx) =>
      callback({
        ...tx,
        query: async (text, values) => {
          if (text.startsWith("SELECT session_key FROM realtime.mcp_sessions"))
            scanned = true;
          return tx.query(text, values);
        },
      }),
    );
    if (scanned)
      await db.exec("UPDATE realtime.mcp_sessions SET alarm_at_ms=NULL");
    return result;
  };
  const first = await peer({}, { ...f.runtime, transaction });
  await register(first);
  await db.exec("UPDATE realtime.mcp_sessions SET alarm_at_ms=0");
  assert.deepEqual(await first.runDueAlarms(1), {
    completed: 0,
    rearmed: 0,
    skipped: 1,
    failed: 0,
  });
  await first.close();
  const second = await peer();
  await register(second);
  await db.exec("UPDATE realtime.mcp_sessions SET alarm_at_ms=0");
  vi.spyOn(McpSessionHub.prototype, "alarm").mockImplementation(async () => {
    await db.exec(
      "UPDATE realtime.mcp_sessions SET alarm_run_token='00000000-0000-4000-8000-000000000000'",
    );
  });
  assert.deepEqual(await second.runDueAlarms(1), {
    completed: 0,
    rearmed: 0,
    skipped: 0,
    failed: 1,
  });
});

test("a renewal crossing the deadline between validation and continuation cannot revive custody", async () => {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "performance",
    ],
  });
  let renewed = false,
    reads = 0;
  vi.spyOn(performance, "now").mockImplementation(() =>
    renewed && ++reads >= 2 ? 60001 : 0,
  );
  const transaction: PgTransactionRunner = async (callback) => {
    let renewal = false;
    const result = await f.runtime.transaction((tx) =>
      callback({
        ...tx,
        run: async (text, values) => {
          if (
            text.startsWith("UPDATE realtime.mcp_sessions SET lease_until_ms=")
          )
            renewal = true;
          return tx.run(text, values);
        },
      }),
    );
    if (renewal) renewed = true;
    return result;
  };
  const service = await peer({}, { ...f.runtime, transaction });
  await register(service);
  const response = await service.fetch("A", request("/stream?sessionId=A"));
  const closed = response.body!.getReader().read();
  await vi.advanceTimersByTimeAsync(10000);
  await flush();
  assert.equal((await closed).done, true);
  assert.equal(service.residentCount, 0);
});

test("shutdown during request buffering prevents acquiring any session", async () => {
  const service = await peer();
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const input = new Request("https://session.invalid/register", {
    method: "POST",
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller;
      },
    }),
    duplex: "half",
  } as RequestInit);
  const pending = service.fetch("A", input);
  const rejected = assert.rejects(pending, /closed/);
  const closed = service.close();
  source.enqueue(new TextEncoder().encode("{}"));
  source.close();
  await Promise.all([rejected, closed]);
  assert.equal(
    (await db.query("SELECT * FROM realtime.mcp_sessions")).rows.length,
    0,
  );
});

test("legacy optional pending state is materialized without losing the session identity", async () => {
  const lease = (await f.store.acquire("A"))!;
  await f.store.save(lease, JSON.stringify({ sessionId: "A" }));
  await f.store.release(lease);
  vi.spyOn(McpSessionHub.prototype, "fetch").mockResolvedValue(
    new Response("preserved"),
  );
  const service = await peer();
  assert.equal(
    await (await service.fetch("A", request("/legacy"))).text(),
    "preserved",
  );
  assert.deepEqual(JSON.parse((await stored()).state), {
    sessionId: "A",
    sequence: 0,
    pendingUris: [],
  });
});

test("an already queued stale abort callback cannot dispose a replacement stream", async () => {
  const service = await peer();
  await register(service);
  await subscribe(service);
  const input = request("/stream?sessionId=A");
  let queued: EventListenerOrEventListenerObject | undefined;
  const add = input.signal.addEventListener.bind(input.signal);
  vi.spyOn(input.signal, "addEventListener").mockImplementation(
    (name, listener, options) => {
      if (name === "abort") queued = listener!;
      add(name, listener, options);
    },
  );
  const old = await service.fetch("A", input);
  const replacement = await service.fetch("A", request("/stream?sessionId=A"));
  assert.equal(typeof queued, "function");
  if (typeof queued === "function")
    queued.call(input.signal, new Event("abort"));
  const reader = replacement.body!.getReader();
  const notification = reader.read();
  await service.fetch("A", request("/notify", { uri }));
  assert.equal((await notification).done, false);
  await reader.cancel();
  await old.body!.cancel();
});

test("source errors already queued at shutdown cannot error the closed bridge", async () => {
  const service = await peer();
  await register(service);
  let source!: ReadableStreamDefaultController<Uint8Array>;
  vi.spyOn(McpSessionHub.prototype, "fetch").mockResolvedValue(
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          source = controller;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    ),
  );
  const response = await service.fetch("A", request("/stream"));
  const pending = response.body!.getReader().read();
  source.error(new Error("late read failure"));
  await service.close();
  assert.equal((await pending).done, true);
});
