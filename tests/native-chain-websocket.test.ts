import assert from "node:assert/strict";
import { once } from "node:events";
import { PGlite } from "@electric-sql/pglite";
import { WebSocket } from "ws";
import { afterEach, beforeEach, afterAll, test, vi } from "vitest";
import { createNativeChainFirehose } from "../src/native-chain-firehose.ts";
import { createNativeChainWebSocketTransport } from "../src/native-chain-websocket.ts";
import {
  chainFixture,
  chainStateLimits,
} from "./helpers/chain-firehose-fixture.ts";
import type { NativeApiProcess } from "../src/native-api-process.ts";

vi.resetModules();
const { listenNativeApi } = await import("../src/native-http-server.ts");
const db = new PGlite();
const cleanups: (() => Promise<unknown>)[] = [];
beforeEach(async () => {
  await db.exec("DROP SCHEMA IF EXISTS realtime CASCADE");
});
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
afterAll(async () => {
  await db.close();
});
const block = {
  table: "blocks" as const,
  block_number: 7,
  block_hash: "0x01",
  parent_hash: "0x00",
  extrinsic_count: 0,
  event_count: null,
  author: null,
  observed_at: 1234,
};
async function fixture() {
  const f = await chainFixture(db);
  const errors: unknown[] = [];
  const chain = await createNativeChainFirehose(f.runtime, {
    ...chainStateLimits,
    maxConcurrentCalls: 8,
    maxPendingCalls: 8,
    maxRequestBytes: 8192,
    maxSocketMessageBytes: 1024,
    maxSocketBufferedBytes: 16384,
    maxPendingSocketMessages: 8,
    renewIntervalMillis: 10000,
    executionTimeoutMillis: 20000,
    drainTimeoutMillis: 1000,
    headPollEnabled: false,
    headPollIntervalMillis: 6000,
    telemetry: {},
    onBackgroundError: (error) => errors.push(error),
    sessions: { fetch: async () => new Response("{}") },
    alerter: { fetch: async () => new Response("{}") },
    head: {
      head: async () => 7,
      block: async () => block,
      write: async () => {},
    },
  });
  const transport = createNativeChainWebSocketTransport(chain, {
    closeGraceMillis: 50,
    onError: (error) => errors.push(error),
  });
  let observed!: () => void;
  const subscribed = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const process: NativeApiProcess<string, string> = {
    get state() {
      return chain.state;
    },
    fetch: async (request) => {
      const response = await chain.fetch(
        new Request(
          new URL("/subscribe" + new URL(request.url).search, request.url),
          request,
        ),
      );
      observed();
      return response;
    },
    scheduled: async () => {},
    queue: async () => {},
    close: async () => {},
  };
  const listener = await listenNativeApi(process, {
    origin: "https://chain.fixture.invalid",
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBytes: 8192,
    requestTimeoutMillis: 1000,
    headersTimeoutMillis: 1000,
    upgrade: transport,
    onError: (error) => errors.push(error),
  });
  cleanups.push(() => listener.close());
  const open = async (path: string, protocol?: string) => {
    const socket = protocol
      ? new WebSocket(
          `ws://127.0.0.1:${listener.address.port}${path}`,
          protocol,
        )
      : new WebSocket(`ws://127.0.0.1:${listener.address.port}${path}`);
    cleanups.push(async () => {
      if (socket.readyState !== WebSocket.CLOSED) {
        const closed = once(socket, "close");
        socket.terminate();
        await closed;
      }
    });
    await once(socket, "open");
    return socket;
  };
  const ingest = () =>
    chain.fetch(
      new Request("https://chain.fixture.invalid/ingest", {
        method: "POST",
        body: JSON.stringify(block),
      }),
    );
  return { chain, listener, open, ingest, subscribed, errors };
}
const message = (socket: WebSocket): Promise<ReturnType<typeof JSON.parse>> =>
  new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off("message", received);
      socket.off("error", failed);
      socket.off("close", closed);
    };
    const received = (value: unknown) => {
      cleanup();
      try {
        resolve(JSON.parse(String(value)));
      } catch (error) {
        reject(error);
      }
    };
    const failed = (error: Error) => {
      cleanup();
      reject(error);
    };
    const closed = (code: number, reason: Buffer) => {
      cleanup();
      reject(
        new Error(`Socket closed before its next frame: ${code} ${reason}`),
      );
    };
    socket.once("message", received);
    socket.once("error", failed);
    socket.once("close", closed);
  });

test("actual native plain WebSocket and SSE receive the same source broadcast", async () => {
  const f = await fixture();
  const socket = await f.open("/api/v1/chain/stream?topics=blocks");
  const frame = message(socket);
  const responsePending = fetch(
    `http://127.0.0.1:${f.listener.address.port}/api/v1/chain/stream?topics=blocks`,
  );
  await f.subscribed;
  await f.ingest();
  const response = await responsePending;
  const reader = response.body!.getReader();
  const sse = reader.read();
  assert.deepEqual(await frame, block);
  assert.match(new TextDecoder().decode((await sse).value), /"block_number":7/);
  await reader.cancel();
});

test("actual GraphQL transport negotiates, subscribes and returns protocol-framed data", async () => {
  const f = await fixture();
  const socket = await f.open("/api/v1/graphql", "graphql-transport-ws");
  assert.equal(socket.protocol, "graphql-transport-ws");
  const acknowledged = message(socket);
  socket.send(JSON.stringify({ type: "connection_init" }));
  assert.equal((await acknowledged).type, "connection_ack");
  socket.send(
    JSON.stringify({
      id: "chain-A",
      type: "subscribe",
      payload: { query: "subscription { chainEvents { table block_number } }" },
    }),
  );
  const pong = message(socket);
  socket.send(JSON.stringify({ type: "ping" }));
  assert.equal((await pong).type, "pong");
  await vi.waitFor(() => {
    assert.deepEqual(f.errors, []);
    assert.equal(f.chain.activeGraphqlSubscriptions, 1);
  });
  const next = message(socket);
  await f.ingest();
  const payload = await next;
  assert.equal(payload.type, "next");
  assert.equal(payload.id, "chain-A");
  assert.deepEqual(payload.payload.data.chainEvents, {
    table: "blocks",
    block_number: 7,
  });
  socket.send(JSON.stringify({ type: "complete", id: "chain-A" }));
  await vi.waitFor(() => assert.equal(f.chain.activeGraphqlSubscriptions, 0));
  assert.deepEqual(f.errors, []);
});

test("the ws parser bounds incoming payloads and shutdown closes sockets", async () => {
  const f = await fixture();
  const socket = await f.open("/api/v1/chain/stream");
  const closed = once(socket, "close");
  socket.send("x".repeat(1025));
  assert.equal((await closed)[0], 1009);
  const survivor = await f.open("/api/v1/chain/stream");
  const stopped = once(survivor, "close");
  await f.listener.close();
  assert.equal((await stopped)[0], 1012);
  assert.equal(f.chain.state, "closed");
});
