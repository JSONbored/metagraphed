import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, afterEach, afterAll, test, vi } from "vitest";
import {
  createNativeChainFirehose,
  type NativeChainOptions,
  type NativeChainSocket,
} from "../src/native-chain-firehose.ts";
import {
  chainFixture,
  chainStateLimits,
} from "./helpers/chain-firehose-fixture.ts";
import {
  CHAIN_FIREHOSE_CAP_HEADER,
  CHAIN_FIREHOSE_MAX_CONNECTIONS_PER_IP,
  CHAIN_FIREHOSE_MAX_WS_CONNECTIONS,
  ChainFirehoseHub,
  formatChainFirehoseSseFrame,
} from "../workers/chain-firehose-hub.ts";
import { queueDeferred } from "./helpers/queue-fixture.ts";

let db: PGlite;
let f: Awaited<ReturnType<typeof chainFixture>>;
const peers: Awaited<ReturnType<typeof createNativeChainFirehose>>[] = [];
const block = (height = 3) => ({
  table: "blocks" as const,
  block_number: height,
  block_hash: "0x01",
  parent_hash: "0x00",
  extrinsic_count: 1,
  event_count: null,
  author: null,
  observed_at: 1000,
});
const ok = { fetch: async () => new Response("{}") };
const options: NativeChainOptions = {
  ...chainStateLimits,
  maxConcurrentCalls: 4,
  maxPendingCalls: 4,
  maxRequestBytes: 8192,
  maxSocketMessageBytes: 8192,
  maxSocketBufferedBytes: 16384,
  maxPendingSocketMessages: 4,
  renewIntervalMillis: 10000,
  executionTimeoutMillis: 20000,
  drainTimeoutMillis: 1000,
  headPollEnabled: true,
  headPollIntervalMillis: 6000,
  sessions: { fetch: ok.fetch },
  alerter: ok,
  head: {
    head: async () => 3,
    block: async (height) => block(height),
    write: async () => {},
  },
  telemetry: {},
  onBackgroundError: () => {},
};
const request = (path: string, body?: unknown, signal?: AbortSignal) =>
  new Request(`https://chain.invalid${path}`, {
    ...(body === undefined
      ? {}
      : { method: "POST", body: JSON.stringify(body) }),
    signal,
    headers: { "cf-connecting-ip": "127.0.0.1" },
  });
const peer = async (overrides: Partial<NativeChainOptions> = {}) => {
  const service = await createNativeChainFirehose(f.runtime, {
    ...options,
    ...overrides,
  });
  peers.push(service);
  return service;
};
const state = async () =>
  JSON.parse(
    (
      await db.query<{ state: string }>(
        "SELECT state FROM realtime.chain_firehose_actor",
      )
    ).rows[0]!.state,
  );
class Socket implements NativeChainSocket {
  bufferedBytes = 0;
  sent: string[] = [];
  closed: { code: number; reason: string } | undefined;
  message?: (message: string | ArrayBuffer) => void;
  ended?: (code: number, reason: string) => void;
  send(value: string) {
    this.sent.push(value);
  }
  close(code: number, reason: string) {
    this.closed = { code, reason };
    this.ended?.(code, reason);
  }
  onMessage(callback: (message: string | ArrayBuffer) => void) {
    this.message = callback;
  }
  onClose(callback: (code: number, reason: string) => void) {
    this.ended = callback;
  }
}
beforeAll(() => {
  db = new PGlite();
});
beforeEach(async () => {
  f = await chainFixture(db);
});
afterEach(async () => {
  await Promise.all(peers.splice(0).map((service) => service.close()));
  vi.restoreAllMocks();
  vi.useRealTimers();
});
afterAll(async () => {
  await db.close();
});

test("requires bounded controls and every native downstream capability", async () => {
  for (const name of ["sessions", "alerter", "head"] as const)
    await assert.rejects(
      createNativeChainFirehose(f.runtime, { ...options, [name]: null }),
      /required/,
    );
  for (const name of [
    "maxPendingCalls",
    "maxSocketMessageBytes",
    "headPollIntervalMillis",
  ] as const)
    await assert.rejects(
      createNativeChainFirehose(f.runtime, { ...options, [name]: 0 }),
      /Invalid native/,
    );
  await assert.rejects(
    createNativeChainFirehose(f.runtime, {
      ...options,
      renewIntervalMillis: 30000,
    }),
    /headroom/,
  );
});

test("resident SSE, native plain sockets and both downstream consumers share one broadcast", async () => {
  const notified: unknown[] = [],
    alerts: unknown[] = [];
  const service = await peer({
    sessions: {
      fetch: async (_id, req) => {
        assert.equal(f.activeTransactions(), 0);
        notified.push(await req.json());
        return new Response("{}");
      },
    },
    alerter: {
      fetch: async (req) => {
        assert.equal(f.activeTransactions(), 0);
        alerts.push(await req.json());
        return new Response("{}");
      },
    },
  });
  await service.fetch(request("/mcp-subscribe", { sessionId: "session-A" }));
  const response = await service.fetch(request("/subscribe?topics=blocks"));
  const reader = response.body!.getReader();
  assert.equal(
    new TextDecoder().decode((await reader.read()).value),
    ": connected\n\n",
  );
  const first = reader.read();
  const socket = new Socket();
  assert.equal(
    await service.openSocket(
      request("/api/v1/chain/stream?topics=blocks"),
      async () => socket,
    ),
    null,
  );
  assert.equal((await service.fetch(request("/ingest", block()))).status, 202);
  assert.equal(
    new TextDecoder().decode((await first).value),
    formatChainFirehoseSseFrame(1, block()),
  );
  assert.deepEqual(
    socket.sent.map((text) => JSON.parse(text)),
    [block()],
  );
  assert.deepEqual(notified, [{ uri: "metagraph://chain/stream" }]);
  assert.deepEqual(alerts, [block()]);
  assert.equal(f.activeTransactions(), 0);
  await reader.cancel();
  await service.close();
  assert.equal(socket.closed?.code, 1012);
  const restarted = await peer();
  assert.deepEqual((await state())["mcp:subscribed-sessions"], ["session-A"]);
  assert.equal((await restarted.fetch(request("/latest"))).status, 200);
});

test("head alarms keep live and durable cursors distinct and perform no I/O until invoked", async () => {
  const writes: number[] = [],
    reads: number[] = [];
  const service = await peer({
    head: {
      head: async () => {
        assert.equal(f.activeTransactions(), 0);
        return 3;
      },
      block: async (height) => {
        reads.push(height);
        return block(height);
      },
      write: async (value) => {
        assert.equal(f.activeTransactions(), 0);
        writes.push(value.block_number);
      },
    },
  });
  assert.deepEqual(reads, []);
  await service.fetch(request("/poll-start", {}));
  assert.deepEqual(reads, []);
  await db.exec("UPDATE realtime.chain_firehose_actor SET alarm_at_ms=0");
  assert.equal(await service.runDueAlarm(), "rearmed");
  assert.deepEqual(reads, [3]);
  assert.deepEqual(writes, [3]);
  assert.equal((await state())["head:last_seen"], 3);
  assert.equal((await state())["head:write_next"], 4);
});

test("GraphQL sockets use the existing protocol and never receive plain event frames", async () => {
  const service = await peer();
  const socket = new Socket();
  const input = new Request("https://chain.invalid/api/v1/graphql", {
    headers: {
      "cf-connecting-ip": "127.0.0.1",
      "sec-websocket-protocol": "graphql-transport-ws",
    },
  });
  await service.openSocket(input, async (protocol) => {
    assert.equal(protocol, "graphql-transport-ws");
    return socket;
  });
  socket.message!(JSON.stringify({ type: "connection_init" }));
  await vi.waitFor(() =>
    assert.ok(
      socket.sent.some(
        (message) => JSON.parse(message).type === "connection_ack",
      ),
    ),
  );
  socket.message!(
    JSON.stringify({
      id: "query-denied",
      type: "subscribe",
      payload: { query: "query { __typename }" },
    }),
  );
  await vi.waitFor(() =>
    assert.ok(
      socket.sent.some((message) => {
        const frame = JSON.parse(message);
        return frame.type === "error" && frame.id === "query-denied";
      }),
    ),
  );
  socket.message!(
    JSON.stringify({
      id: "subscription-A",
      type: "subscribe",
      payload: { query: "subscription { chainEvents { table block_number } }" },
    }),
  );
  socket.message!(JSON.stringify({ type: "ping" }));
  await vi.waitFor(() =>
    assert.ok(
      socket.sent.some((message) => JSON.parse(message).type === "pong"),
    ),
  );
  await vi.waitFor(() =>
    assert.equal(
      service.activeGraphqlSubscriptions,
      1,
      JSON.stringify(socket.sent),
    ),
  );
  await service.fetch(request("/ingest", block()));
  await vi.waitFor(() =>
    assert.ok(
      socket.sent.some((message) => JSON.parse(message).type === "next"),
    ),
  );
  assert.ok(
    socket.sent.every(
      (message) => typeof JSON.parse(message).type === "string",
    ),
  );
  socket.message!(JSON.stringify({ type: "complete", id: "subscription-A" }));
  await vi.waitFor(() => assert.equal(service.activeGraphqlSubscriptions, 0));
});

test("slow socket buffers close locally and a disconnected upload leaves the owner ready", async () => {
  const service = await peer();
  const socket = new Socket();
  await service.openSocket(request("/api/v1/chain/stream"), async () => socket);
  socket.bufferedBytes = 100000;
  await service.fetch(request("/ingest", block()));
  assert.equal(socket.closed?.code, 1013);
  const abort = new AbortController();
  const stalled = new Request("https://chain.invalid/ingest", {
    method: "POST",
    body: new ReadableStream(),
    duplex: "half",
    signal: abort.signal,
  } as RequestInit);
  const pending = service.fetch(stalled);
  const rejected = assert.rejects(pending, /client left/);
  abort.abort(new Error("client left"));
  await rejected;
  assert.equal(service.state, "ready");
});

test("monotonic expiry closes live clients and stale ownership cannot write after takeover", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const first = await peer();
  const response = await first.fetch(request("/subscribe"));
  const reader = response.body!.getReader();
  await reader.read();
  const pending = reader.read();
  now = 60001;
  await assert.rejects(
    first.fetch(request("/mcp-subscribe", { sessionId: "late" })),
    /ownership/,
  );
  assert.equal((await pending).done, true);
  await db.exec("UPDATE realtime.chain_firehose_actor SET lease_until_ms=0");
  const second = await peer();
  assert.equal(
    (await second.fetch(request("/mcp-subscribe", { sessionId: "new" })))
      .status,
    200,
  );
  assert.deepEqual((await state())["mcp:subscribed-sessions"], ["new"]);
});

test("a drain timeout remains closing and retries after an uncooperative head write exits", async () => {
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
    head: {
      ...options.head,
      write: async () => {
        entered.resolve();
        await gate.promise;
      },
    },
  });
  await service.fetch(request("/poll-start", {}));
  await db.exec("UPDATE realtime.chain_firehose_actor SET alarm_at_ms=0");
  const run = service.runDueAlarm();
  const rejected = assert.rejects(run, /drain deadline/);
  await entered.promise;
  const firstClose = assert.rejects(service.close(), /drain deadline/);
  try {
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all([firstClose, rejected]);
    assert.equal(service.state, "closing");
  } finally {
    gate.resolve();
  }
  await db.query("SELECT 1");
  await service.close();
  assert.equal(service.state, "closed");
});

test("native socket admission enforces source IP and global limits and reclaims closed slots", async () => {
  const service = await peer();
  const sockets: Socket[] = [];
  const connect = async () => {
    const socket = new Socket();
    sockets.push(socket);
    return socket;
  };
  for (let index = 0; index < CHAIN_FIREHOSE_MAX_CONNECTIONS_PER_IP; index++)
    assert.equal(
      await service.openSocket(request("/subscribe"), connect),
      null,
    );
  const ipFull = await service.openSocket(request("/subscribe"), connect);
  assert.equal(ipFull?.status, 503);
  assert.equal(ipFull?.headers.get(CHAIN_FIREHOSE_CAP_HEADER), "ws-per-ip");
  assert.equal(sockets.length, CHAIN_FIREHOSE_MAX_CONNECTIONS_PER_IP);
  sockets[0]!.ended!(1000, "peer closed");
  assert.equal(await service.openSocket(request("/subscribe"), connect), null);
  for (
    let index = CHAIN_FIREHOSE_MAX_CONNECTIONS_PER_IP;
    index < CHAIN_FIREHOSE_MAX_WS_CONNECTIONS;
    index++
  ) {
    const input = new Request("https://chain.invalid/subscribe", {
      headers: {
        "cf-connecting-ip": `198.51.${Math.floor(index / 250)}.${(index % 250) + 1}`,
      },
    });
    assert.equal(await service.openSocket(input, connect), null);
  }
  const globallyFull = await service.openSocket(request("/subscribe"), connect);
  assert.equal(globallyFull?.status, 503);
  assert.equal(
    globallyFull?.headers.get(CHAIN_FIREHOSE_CAP_HEADER),
    "ws-global",
  );
});

test("bad admission and a broken local socket do not retire the shared owner", async () => {
  const errors: unknown[] = [];
  const service = await peer({
    onBackgroundError: (error) => {
      errors.push(error);
      throw new Error("reporter unavailable");
    },
  });
  assert.equal(
    (
      await service.openSocket(
        request("/subscribe", {}),
        async () => new Socket(),
      )
    )?.status,
    405,
  );
  assert.equal(
    (
      await service.openSocket(request("/subscribe"), async () => {
        throw new Error("handshake lost");
      })
    )?.status,
    400,
  );
  const socket = new Socket();
  socket.send = () => {
    throw new Error("send lost");
  };
  await service.openSocket(request("/subscribe"), async () => socket);
  socket.message!(new Uint8Array([1]).buffer);
  assert.equal((await service.fetch(request("/ingest", block()))).status, 202);
  assert.equal(socket.closed?.code, 1011);
  assert.equal(service.state, "ready");
  assert.equal(errors.length, 2);
});

test("protocol message bounds close only the offending GraphQL socket", async () => {
  const service = await peer({ maxSocketMessageBytes: 64 });
  const socket = new Socket();
  await service.openSocket(
    new Request("https://chain.invalid/subscribe", {
      headers: { "sec-websocket-protocol": "graphql-transport-ws" },
    }),
    async () => socket,
  );
  socket.message!(
    Uint8Array.from(new TextEncoder().encode("x".repeat(65))).buffer,
  );
  assert.equal(socket.closed?.code, 1009);
  assert.equal(service.state, "ready");
  const malformed = new Socket();
  await service.openSocket(
    new Request("https://chain.invalid/subscribe", {
      headers: { "sec-websocket-protocol": "graphql-transport-ws" },
    }),
    async () => malformed,
  );
  malformed.message!("not JSON");
  await vi.waitFor(() => assert.equal(malformed.closed?.code, 4400));
  assert.equal(service.state, "ready");
  const burst = new Socket();
  await service.openSocket(
    new Request("https://chain.invalid/subscribe", {
      headers: { "sec-websocket-protocol": "graphql-transport-ws" },
    }),
    async () => burst,
  );
  for (let index = 0; index <= options.maxPendingSocketMessages; index++)
    burst.message!(JSON.stringify({ type: "ping" }));
  assert.equal(burst.closed?.code, 1009);
  assert.equal(service.state, "ready");
});

test("an upgrade completing after ownership expires cannot admit a socket", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const service = await peer();
  const entered = queueDeferred(),
    resume = queueDeferred();
  const socket = new Socket();
  const pending = service.openSocket(request("/subscribe"), async () => {
    entered.resolve();
    await resume.promise;
    return socket;
  });
  const rejected = assert.rejects(pending, /ownership/);
  await entered.promise;
  now = 60001;
  resume.resolve();
  await rejected;
  assert.equal(socket.closed?.code, 1012);
  assert.equal(service.state, "closing");
});

test("an SSE caller aborting before bridge registration releases its source slot", async () => {
  const service = await peer();
  const abort = new AbortController();
  const original = ChainFirehoseHub.prototype.fetch;
  const captured: ChainFirehoseHub[] = [];
  vi.spyOn(ChainFirehoseHub.prototype, "fetch").mockImplementation(
    async function (this: ChainFirehoseHub, input) {
      const response = await original.call(this, input);
      captured.push(this);
      abort.abort(new Error("caller disconnected before bridge registration"));
      return response;
    },
  );
  const response = await service.fetch(
    request("/subscribe", undefined, abort.signal),
  );
  assert.equal((await response.body!.getReader().read()).done, true);
  assert.equal(captured[0]?.sseClients.size, 0);
  assert.equal(service.state, "ready");
});

test("lease admission rejects a second owner and releases a lease acquired too late", async () => {
  const service = await peer();
  await assert.rejects(
    createNativeChainFirehose(f.runtime, options),
    /another process/,
  );
  await service.close();
  let now = 0,
    transactions = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const original = f.runtime.transaction;
  vi.spyOn(f.runtime, "transaction").mockImplementation(
    async (callback, options) => {
      const result = await original(callback, options);
      if (++transactions === 3) now = 60001;
      return result;
    },
  );
  await assert.rejects(
    createNativeChainFirehose(f.runtime, options),
    /safe deadline/,
  );
  assert.equal(
    (
      await db.query<{ owner_token: string | null }>(
        "SELECT owner_token FROM realtime.chain_firehose_actor",
      )
    ).rows[0]!.owner_token,
    null,
  );
});

test("renewal extends custody and a database renewal failure retires live streams", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const service = await peer({
    leaseMilliseconds: 6000,
    renewIntervalMillis: 1000,
    executionTimeoutMillis: 2000,
  });
  const response = await service.fetch(request("/subscribe"));
  const reader = response.body!.getReader();
  await reader.read();
  const pending = reader.read();
  const transaction = vi.spyOn(f.runtime, "transaction");
  await vi.advanceTimersByTimeAsync(1000);
  assert.ok(transaction.mock.calls.length > 0);
  assert.equal(service.state, "ready");
  transaction.mockRejectedValueOnce(new Error("renewal database unavailable"));
  await vi.advanceTimersByTimeAsync(1000);
  assert.equal(service.state, "closing");
  assert.equal((await pending).done, true);
  transaction.mockRestore();
});

test("the expiry timer fences a renewal that never completes", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const service = await peer({
    leaseMilliseconds: 6000,
    renewIntervalMillis: 1000,
    executionTimeoutMillis: 2000,
  });
  const started = queueDeferred(),
    release = queueDeferred();
  const original = f.runtime.transaction;
  vi.spyOn(f.runtime, "transaction").mockImplementationOnce(
    async (callback, options) => {
      const result = await original(callback, options);
      started.resolve();
      await release.promise;
      return result;
    },
  );
  await vi.advanceTimersByTimeAsync(1000);
  await started.promise;
  await vi.advanceTimersByTimeAsync(5001);
  assert.equal(service.state, "closing");
  release.resolve();
  await service.close();
  await assert.rejects(service.fetch(request("/latest")), /closing/);
});

test("input and serialized call admission stay bounded without retiring accepted work", async () => {
  const service = await peer({ maxConcurrentCalls: 1 });
  const abort = new AbortController();
  const started = queueDeferred();
  const pending = service.fetch(
    new Request("https://chain.invalid/ingest", {
      method: "POST",
      body: new ReadableStream({
        pull() {
          started.resolve();
          return new Promise(() => {});
        },
      }),
      duplex: "half",
      signal: abort.signal,
    } as RequestInit),
  );
  const rejected = assert.rejects(pending, /upload left/);
  await started.promise;
  await assert.rejects(service.fetch(request("/latest")), /capacity/);
  await assert.rejects(service.runDueAlarm(), /capacity/);
  abort.abort(new Error("upload left"));
  await rejected;
  assert.equal(service.state, "ready");
  assert.equal(
    (
      await service.fetch(
        new Request("https://chain.invalid/subscribe", {
          headers: { upgrade: "websocket" },
        }),
      )
    ).status,
    426,
  );
  await service.close();

  const gate = queueDeferred(),
    entered = queueDeferred();
  const queued = await peer({
    maxPendingCalls: 1,
    head: {
      ...options.head,
      head: async () => {
        entered.resolve();
        await gate.promise;
        return 3;
      },
    },
  });
  await queued.fetch(request("/poll-start", {}));
  await db.exec("UPDATE realtime.chain_firehose_actor SET alarm_at_ms=0");
  const alarm = queued.runDueAlarm();
  await entered.promise;
  await assert.rejects(queued.fetch(request("/latest")), /capacity/);
  assert.equal(queued.state, "ready");
  gate.resolve();
  await alarm;
});

test("source stream completion, errors and failed cancellation release the bridge", async () => {
  const errors: unknown[] = [];
  const service = await peer({
    onBackgroundError: (error) => errors.push(error),
  });
  const replacement = vi.spyOn(ChainFirehoseHub.prototype, "fetch");
  const sse = (body: ReadableStream) =>
    new Response(body, { headers: { "content-type": "text/event-stream" } });
  replacement.mockResolvedValueOnce(new Response(null, { status: 204 }));
  assert.equal((await service.fetch(request("/fixture"))).status, 204);
  replacement.mockResolvedValueOnce(
    sse(
      new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
    ),
  );
  assert.equal(
    (await (await service.fetch(request("/fixture"))).body!.getReader().read())
      .done,
    true,
  );
  replacement.mockResolvedValueOnce(
    sse(
      new ReadableStream({
        start(controller) {
          controller.error(new Error("source read failed"));
        },
      }),
    ),
  );
  await assert.rejects(
    (await service.fetch(request("/fixture"))).body!.getReader().read(),
    /source read failed/,
  );
  replacement.mockResolvedValueOnce(
    sse(
      new ReadableStream({
        cancel() {
          throw new Error("source cancellation failed");
        },
      }),
    ),
  );
  await (await service.fetch(request("/fixture"))).body!.getReader().cancel();
  await vi.waitFor(() => assert.equal(errors.length, 1));
  assert.equal(service.state, "ready");
});

test("source background work and Date alarms drain before returning a response", async () => {
  const errors: unknown[] = [];
  const service = await peer({
    onBackgroundError: (error) => errors.push(error),
  });
  vi.spyOn(ChainFirehoseHub.prototype, "fetch").mockImplementation(
    async function (this: ChainFirehoseHub) {
      this.state.waitUntil(Promise.reject(new Error("background failed")));
      await this.state.storage.setAlarm(new Date(Date.now() + 60000));
      return new Response("fixture");
    },
  );
  assert.equal(
    await (await service.fetch(request("/fixture"))).text(),
    "fixture",
  );
  assert.equal(errors.length, 1);
  assert.ok(
    (
      await db.query<{ alarm_at_ms: number }>(
        "SELECT alarm_at_ms FROM realtime.chain_firehose_actor",
      )
    ).rows[0]!.alarm_at_ms > Date.now(),
  );
});

test("alarm completion and source exceptions settle their exact claims", async () => {
  const service = await peer();
  assert.equal(await service.runDueAlarm(), "skipped");
  const alarm = vi
    .spyOn(ChainFirehoseHub.prototype, "alarm")
    .mockResolvedValue(undefined);
  await service.fetch(request("/poll-start", {}));
  await db.exec("UPDATE realtime.chain_firehose_actor SET alarm_at_ms=0");
  assert.equal(await service.runDueAlarm(), "completed");
  alarm.mockRejectedValueOnce(new Error("source alarm failed"));
  await db.exec("UPDATE realtime.chain_firehose_actor SET alarm_at_ms=0");
  await assert.rejects(service.runDueAlarm(), /source alarm failed/);
  assert.equal(
    (
      await db.query<{ alarm_outcome: string }>(
        "SELECT alarm_outcome FROM realtime.chain_firehose_actor",
      )
    ).rows[0]!.alarm_outcome,
    "retry",
  );
});

test("a superseded alarm claim cannot be recorded as complete", async () => {
  const service = await peer();
  await service.fetch(request("/poll-start", {}));
  await db.exec("UPDATE realtime.chain_firehose_actor SET alarm_at_ms=0");
  vi.spyOn(ChainFirehoseHub.prototype, "alarm").mockImplementation(async () => {
    await db.exec(
      "UPDATE realtime.chain_firehose_actor SET alarm_run_token='00000000-0000-4000-8000-000000000001'",
    );
  });
  await assert.rejects(
    service.runDueAlarm(),
    /Native chain alarm claim was superseded/,
  );
  assert.equal(service.state, "closing");
});

test("a renewal crossing the deadline after the storage guard cannot revive custody", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let now = 0,
    crossDeadline = false;
  vi.spyOn(performance, "now").mockImplementation(() => {
    if (crossDeadline) {
      crossDeadline = false;
      queueMicrotask(() => {
        now = 6001;
      });
    }
    return now;
  });
  const service = await peer({
    leaseMilliseconds: 6000,
    renewIntervalMillis: 1000,
    executionTimeoutMillis: 2000,
  });
  const original = f.runtime.transaction;
  vi.spyOn(f.runtime, "transaction").mockImplementationOnce(
    async (callback, options) => {
      const result = await original(callback, options);
      crossDeadline = true;
      return result;
    },
  );
  now = 1000;
  await vi.advanceTimersByTimeAsync(1000);
  assert.equal(service.state, "closing");
});

test("queued renewal callbacks and late protocol work cannot reopen a retired owner", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const timers = vi.spyOn(globalThis, "setTimeout");
  const errors: unknown[] = [];
  const service = await peer({
    onBackgroundError: (error) => errors.push(error),
  });
  const staleRenewal = timers.mock.calls.find(
    (call) => call[1] === options.renewIntervalMillis,
  )![0];
  const captured: ChainFirehoseHub[] = [];
  const original = ChainFirehoseHub.prototype.fetch;
  vi.spyOn(ChainFirehoseHub.prototype, "fetch").mockImplementation(
    async function (this: ChainFirehoseHub, request) {
      captured.push(this);
      return original.call(this, request);
    },
  );
  await service.fetch(request("/latest"));
  const hub = captured[0]!;
  assert.equal(await hub.native!.head.head(), 3);
  assert.throws(
    () => hub.state.acceptWebSocket({} as WebSocket),
    /explicit admission/,
  );
  let adapter!: Parameters<typeof hub.graphqlWsServer.opened>[0];
  vi.spyOn(hub.graphqlWsServer, "opened").mockImplementation((socket) => {
    adapter = socket;
    socket.onMessage(async () => {
      throw new Error("protocol callback failed");
    });
    return async () => {};
  });
  const socket = new Socket();
  await service.openSocket(
    new Request("https://chain.invalid/subscribe", {
      headers: { "sec-websocket-protocol": "graphql-transport-ws" },
    }),
    async () => socket,
  );
  socket.message!("protocol frame");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(socket.closed?.code, 1011);
  assert.equal(errors.length, 1);
  assert.doesNotThrow(() => adapter.send("late frame"));
  const optionalClose = new Socket();
  await service.openSocket(
    new Request("https://chain.invalid/subscribe", {
      headers: { "sec-websocket-protocol": "graphql-transport-ws" },
    }),
    async () => optionalClose,
  );
  adapter.close();
  assert.deepEqual(optionalClose.closed, { code: 1000, reason: "" });
  await service.close();
  if (typeof staleRenewal === "function") staleRenewal();
  assert.equal(service.state, "closed");
});

test("a queued socket frame is discarded when its connection closes first", async () => {
  const service = await peer();
  const socket = new Socket();
  await service.openSocket(
    new Request("https://chain.invalid/subscribe", {
      headers: { "sec-websocket-protocol": "graphql-transport-ws" },
    }),
    async () => socket,
  );
  socket.message!(JSON.stringify({ type: "connection_init" }));
  socket.ended!(1000, "peer finished");
  await service.close();
  assert.deepEqual(socket.sent, []);
});

test("a source read error already queued when a caller aborts does not error its closed bridge", async () => {
  const errors: unknown[] = [];
  const service = await peer({
    onBackgroundError: (error) => errors.push(error),
  });
  let source!: ReadableStreamDefaultController<Uint8Array>;
  vi.spyOn(ChainFirehoseHub.prototype, "fetch").mockResolvedValue(
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          source = controller;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    ),
  );
  const abort = new AbortController();
  const response = await service.fetch(
    request("/subscribe", undefined, abort.signal),
  );
  const pending = response.body!.getReader().read();
  source.error(new Error("queued source error"));
  abort.abort();
  assert.equal((await pending).done, true);
  await Promise.resolve();
  assert.equal(service.state, "ready");
});
