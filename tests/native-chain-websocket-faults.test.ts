import assert from "node:assert/strict";
import type { EventEmitter } from "node:events";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, test, vi } from "vitest";
import { GRAPHQL_TRANSPORT_WS_PROTOCOL } from "graphql-ws";
import { CHAIN_FIREHOSE_CAP_HEADER } from "../workers/chain-firehose-hub.ts";
import type {
  NativeChainSocket,
  createNativeChainFirehose,
} from "../src/native-chain-firehose.ts";
import type { NativeHttpUpgrade } from "../src/native-http-server.ts";

interface TestSocket extends EventEmitter {
  readyState: number;
  bufferedAmount: number;
  closeEmits: boolean;
  sendError?: Error;
  sent: string[];
  closes: { code: number; reason: string }[];
  terminated: number;
  close(code: number, reason: string): void;
  terminate(): void;
}
interface ServerOptions {
  noServer: boolean;
  clientTracking: boolean;
  perMessageDeflate: boolean;
  maxPayload: number;
  handleProtocols(protocols: Set<string>): string | false;
}
interface TestServer {
  options: ServerOptions;
  closeCalls: number;
}
const mock = vi.hoisted(() => ({
  handshake: "success" as "success" | "throw" | "error" | "close" | "defer",
  server: null as TestServer | null,
  sockets: [] as TestSocket[],
  finishHandshake: null as (() => void) | null,
  closeFailures: 0,
}));

vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeSocket extends EventEmitter implements TestSocket {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = FakeSocket.OPEN;
    bufferedAmount = 0;
    closeEmits = true;
    sendError?: Error;
    sent: string[] = [];
    closes: { code: number; reason: string }[] = [];
    terminated = 0;
    constructor() {
      super();
      mock.sockets.push(this);
    }
    send(value: string, callback: (error?: Error) => void) {
      this.sent.push(value);
      callback(this.sendError);
    }
    close(code: number, reason: string) {
      this.closes.push({ code, reason });
      if (this.closeEmits) {
        this.readyState = FakeSocket.CLOSED;
        this.emit("close", code, Buffer.from(reason));
      } else this.readyState = 2;
    }
    terminate() {
      this.terminated++;
      this.readyState = FakeSocket.CLOSED;
      this.emit("close", 1006, Buffer.from("terminated"));
    }
  }
  class FakeServer implements TestServer {
    closeCalls = 0;
    constructor(readonly options: ServerOptions) {
      mock.server = this;
    }
    handleUpgrade(
      _request: IncomingMessage,
      socket: PassThrough,
      _head: Buffer,
      callback: (socket: TestSocket) => void,
    ) {
      if (mock.handshake === "throw") throw new Error("handshake threw");
      if (mock.handshake === "error") {
        socket.destroy(new Error("handshake error"));
        return;
      }
      if (mock.handshake === "close") {
        socket.destroy();
        return;
      }
      const finish = () => callback(new FakeSocket());
      if (mock.handshake === "defer") mock.finishHandshake = finish;
      else finish();
    }
    close(callback: (error?: Error) => void) {
      this.closeCalls++;
      if (mock.closeFailures > 0) {
        mock.closeFailures--;
        callback(new Error("close failed"));
      } else callback();
    }
  }
  return { WebSocket: FakeSocket, WebSocketServer: FakeServer };
});

import { createNativeChainWebSocketTransport } from "../src/native-chain-websocket.ts";

const transports: NativeHttpUpgrade[] = [];
const rawSockets: PassThrough[] = [];
const incomingSockets: Socket[] = [];
beforeEach(() => {
  mock.handshake = "success";
  mock.server = null;
  mock.sockets = [];
  mock.finishHandshake = null;
  mock.closeFailures = 0;
});
afterEach(async () => {
  for (const socket of mock.sockets) socket.terminate();
  for (const transport of transports.splice(0))
    await transport.close().catch(() => {});
  for (const socket of rawSockets.splice(0)) socket.destroy();
  for (const socket of incomingSockets.splice(0)) socket.destroy();
  vi.useRealTimers();
});

function fixture(onError?: (error: unknown) => void) {
  const state = {
    value: "ready" as "ready" | "closing" | "closed",
    refusal: null as Response | null,
  };
  let adapter: NativeChainSocket | undefined;
  const errors: unknown[] = [];
  const chain = {
    get state() {
      return state.value;
    },
    activeGraphqlSubscriptions: 0,
    maxMessageBytes: 1024,
    fetch: async () => new Response("unused"),
    runDueAlarm: async () => "skipped" as const,
    async openSocket(
      _request: Request,
      connect: (protocol: string | null) => Promise<NativeChainSocket>,
    ) {
      if (state.refusal) return state.refusal;
      try {
        adapter = await connect(null);
        return null;
      } catch {
        return new Response("handshake failed", { status: 400 });
      }
    },
    close: vi.fn(async () => {
      state.value = "closed";
    }),
  } satisfies Awaited<ReturnType<typeof createNativeChainFirehose>>;
  const transport = createNativeChainWebSocketTransport(chain, {
    closeGraceMillis: 20,
    onError: onError ?? ((error) => errors.push(error)),
  });
  transports.push(transport);
  const request = (path = "/api/v1/chain/stream") =>
    new Request(`https://example.com${path}`);
  const raw = () => {
    const socket = new PassThrough();
    const data: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => data.push(Buffer.from(chunk)));
    rawSockets.push(socket);
    const peer = new Socket();
    incomingSockets.push(peer);
    return {
      socket,
      incoming: new IncomingMessage(peer),
      text: () => Buffer.concat(data).toString(),
    };
  };
  const handle = async (path = "/api/v1/chain/stream") => {
    const io = raw();
    await transport.handle(
      request(path),
      io.incoming,
      io.socket,
      Buffer.alloc(0),
    );
    return io;
  };
  return {
    chain,
    state,
    errors,
    transport,
    request,
    raw,
    handle,
    adapter: () => {
      assert.ok(adapter);
      return adapter;
    },
  };
}

test("transport validates bounds and configures only the intended protocol and payload limits", () => {
  const f = fixture();
  for (const closeGraceMillis of [0, 10001, 1.5, NaN])
    assert.throws(
      () =>
        createNativeChainWebSocketTransport(f.chain, {
          closeGraceMillis,
          onError() {},
        }),
      /bounds/,
    );
  assert.throws(
    () =>
      createNativeChainWebSocketTransport(f.chain, {
        closeGraceMillis: 1,
        onError: 1 as never,
      }),
    /bounds/,
  );
  assert.deepEqual(
    {
      noServer: mock.server!.options.noServer,
      clientTracking: mock.server!.options.clientTracking,
      perMessageDeflate: mock.server!.options.perMessageDeflate,
      maxPayload: mock.server!.options.maxPayload,
    },
    {
      noServer: true,
      clientTracking: false,
      perMessageDeflate: false,
      maxPayload: 1024,
    },
  );
  assert.equal(
    mock.server!.options.handleProtocols(
      new Set([GRAPHQL_TRANSPORT_WS_PROTOCOL]),
    ),
    GRAPHQL_TRANSPORT_WS_PROTOCOL,
  );
  assert.equal(
    mock.server!.options.handleProtocols(new Set(["unrelated"])),
    false,
  );
});

test("refusal responses strip the internal cap header and tolerate an ended socket", async () => {
  const f = fixture();
  f.state.refusal = new Response("limited", {
    status: 503,
    statusText: "Busy",
    headers: {
      [CHAIN_FIREHOSE_CAP_HEADER]: "private-cap",
      "x-fixture": "kept",
    },
  });
  const refused = await f.handle();
  assert.match(refused.text(), /^HTTP\/1.1 503 Busy/);
  assert.match(refused.text(), /content-length: 7\r\n/);
  assert.match(refused.text(), /x-fixture: kept/);
  assert.doesNotMatch(refused.text(), /private-cap/);
  assert.ok(refused.text().endsWith("limited"));
  const destroyed = f.raw();
  destroyed.socket.destroy();
  await f.transport.handle(
    f.request(),
    destroyed.incoming,
    destroyed.socket,
    Buffer.alloc(0),
  );
  assert.equal(destroyed.text(), "");
  const ended = f.raw();
  ended.socket.end();
  await f.transport.handle(
    f.request(),
    ended.incoming,
    ended.socket,
    Buffer.alloc(0),
  );
  assert.equal(ended.text(), "");
});

test("unavailable, unknown and closed transports refuse upgrades before connecting", async () => {
  const f = fixture();
  f.state.value = "closing";
  assert.match((await f.handle()).text(), /^HTTP\/1.1 503 Upgrade rejected/);
  f.state.value = "ready";
  assert.match(
    (await f.handle("/unknown")).text(),
    /^HTTP\/1.1 404 Upgrade rejected/,
  );
  await f.transport.close();
  assert.match((await f.handle()).text(), /^HTTP\/1.1 503 Upgrade rejected/);
  assert.equal(mock.sockets.length, 0);
});

test("failed, closed and throwing handshakes release their raw-socket listeners", async () => {
  for (const mode of ["error", "close", "throw"] as const) {
    mock.handshake = mode;
    const f = fixture();
    const io = await f.handle();
    assert.equal(io.socket.listenerCount("error"), 0);
    assert.equal(io.socket.listenerCount("close"), 0);
    if (mode === "throw") assert.match(io.text(), /^HTTP\/1.1 400/);
    assert.equal(mock.sockets.length, 0);
  }
});

test("a late completed handshake cannot reopen a closed transport", async () => {
  mock.handshake = "defer";
  const f = fixture();
  const pending = f.handle();
  assert.ok(mock.finishHandshake);
  await f.transport.close();
  mock.finishHandshake();
  await pending;
  assert.equal(mock.sockets[0]!.terminated, 1);
});

test("the socket adapter converts bounded wire data and forwards close exactly once", async () => {
  const f = fixture();
  await f.handle("/api/v1/graphql");
  const adapter = f.adapter(),
    socket = mock.sockets[0]!;
  socket.bufferedAmount = 17;
  assert.equal(adapter.bufferedBytes, 17);
  adapter.send("outgoing");
  assert.deepEqual(socket.sent, ["outgoing"]);
  const received: (string | ArrayBuffer)[] = [];
  adapter.onMessage((value) => received.push(value));
  socket.emit("message", Buffer.from("text"), false);
  socket.emit("message", [Buffer.from("bi"), Buffer.from("n")], true);
  socket.emit("message", Uint8Array.from([97, 98]).buffer, true);
  assert.equal(received[0], "text");
  assert.equal(Buffer.from(received[1] as ArrayBuffer).toString(), "bin");
  assert.equal(Buffer.from(received[2] as ArrayBuffer).toString(), "ab");
  const closes: [number, string][] = [];
  adapter.onClose((code, reason) => closes.push([code, reason]));
  adapter.close(1000, "done");
  socket.emit("close", 1001, Buffer.from("ignored"));
  assert.deepEqual(closes, [[1000, "done"]]);
  assert.throws(() => adapter.send("late"), /not open/);
});

test("send callback failure terminates the socket even when the reporter throws", async () => {
  const f = fixture(() => {
    throw new Error("reporter failed");
  });
  await f.handle();
  mock.sockets[0]!.sendError = new Error("write failed");
  assert.doesNotThrow(() => f.adapter().send("outgoing"));
  assert.equal(mock.sockets[0]!.terminated, 1);
});

test("close handles empty, already closed and forced sockets and retries a failed server callback", async () => {
  const empty = fixture();
  mock.closeFailures = 1;
  await assert.rejects(empty.transport.close(), /close failed/);
  await empty.transport.close();
  assert.equal(mock.server!.closeCalls, 2);
  const f = fixture();
  await f.handle();
  mock.sockets.at(-1)!.readyState = 3;
  await f.handle();
  const slow = mock.sockets.at(-1)!;
  slow.closeEmits = false;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const closing = f.transport.close();
  assert.equal(f.transport.close(), closing);
  await vi.advanceTimersByTimeAsync(20);
  await closing;
  assert.equal(slow.terminated, 1);
  assert.deepEqual(slow.closes, [
    { code: 1012, reason: "chain transport is closing; reconnect" },
  ]);
  assert.equal(f.chain.close.mock.calls.length, 1);
});
