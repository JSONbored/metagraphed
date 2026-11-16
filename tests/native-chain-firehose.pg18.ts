import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, beforeEach, after, describe, it } from "node:test";
import { Client } from "pg";
import { setImmediate as nextTurn } from "node:timers/promises";
import {
  createPgStoreRuntime,
  type PgStoreRuntime,
} from "../src/pg-store-runtime.ts";
import {
  createNativeChainFirehose,
  type NativeChainOptions,
  type NativeChainSocket,
} from "../src/native-chain-firehose.ts";
import { createPgChainFirehoseStore } from "../src/pg-chain-firehose-store.ts";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";
const connectionString = pg18FixtureUrl().toString();
const control = new Client({
  connectionString,
  connectionTimeoutMillis: 2000,
  statement_timeout: 5000,
});
const migration = readFileSync(
  new URL(
    "../migrations/postgres/0034_chain_firehose_actor.sql",
    import.meta.url,
  ),
  "utf8",
);
let runtime: PgStoreRuntime;
const services: Awaited<ReturnType<typeof createNativeChainFirehose>>[] = [];
const block = (height = 3) => ({
  table: "blocks" as const,
  block_number: height,
  block_hash: "0x01",
  parent_hash: "0x00",
  extrinsic_count: 1,
  event_count: null,
  author: null,
  observed_at: 1234,
});
const ok = { fetch: async () => new Response("{}") };
const options: NativeChainOptions = {
  maxStateBytes: 131072,
  leaseMilliseconds: 60000,
  maxConcurrentCalls: 4,
  maxPendingCalls: 4,
  maxRequestBytes: 8192,
  maxSocketMessageBytes: 8192,
  maxSocketBufferedBytes: 16384,
  maxPendingSocketMessages: 32,
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
const request = (path: string, body?: unknown) =>
  new Request(
    `https://chain.invalid${path}`,
    body === undefined ? {} : { method: "POST", body: JSON.stringify(body) },
  );
const peer = async (overrides: Partial<NativeChainOptions> = {}) => {
  const service = await createNativeChainFirehose(runtime, {
    ...options,
    ...overrides,
  });
  services.push(service);
  return service;
};
const state = async () =>
  JSON.parse(
    (await control.query("SELECT state FROM realtime.chain_firehose_actor"))
      .rows[0].state,
  );

describe("native ChainFirehose on PostgreSQL", { concurrency: false }, () => {
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
    await control.query(migration);
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

  it("SSE and downstream notification reuse the one-connection pool without holding a transaction", async () => {
    let notified = 0;
    const service = await peer({
      sessions: {
        fetch: async () => {
          await runtime.producer.query("SELECT 1");
          notified++;
          return new Response("{}");
        },
      },
      alerter: {
        fetch: async () => {
          await runtime.producer.query("SELECT 1");
          return new Response("{}");
        },
      },
    });
    await service.fetch(request("/mcp-subscribe", { sessionId: "A" }));
    const response = await service.fetch(request("/subscribe"));
    const reader = response.body!.getReader();
    await reader.read();
    const pending = reader.read();
    await runtime.producer.query("SELECT 1");
    assert.equal(
      (await service.fetch(request("/ingest", block()))).status,
      202,
    );
    assert.match(
      new TextDecoder().decode((await pending).value),
      /"block_number":3/,
    );
    assert.equal(notified, 1);
    await reader.cancel();
  });

  it("failed head writes leave a durable repair cursor while the live cursor continues", async () => {
    let fail = true,
      head = 3;
    const writes: number[] = [];
    const service = await peer({
      head: {
        head: async () => head,
        block: async (height) => block(height),
        write: async (value) => {
          await runtime.producer.query("SELECT 1");
          if (fail) throw new Error("fixture write unavailable");
          writes.push(value.block_number);
        },
      },
    });
    await service.fetch(request("/poll-start", {}));
    await control.query(
      "UPDATE realtime.chain_firehose_actor SET alarm_at_ms=0",
    );
    assert.equal(await service.runDueAlarm(), "rearmed");
    assert.equal((await state())["head:last_seen"], 3);
    assert.equal((await state())["head:write_next"], 3);
    fail = false;
    head = 4;
    await control.query(
      "UPDATE realtime.chain_firehose_actor SET alarm_at_ms=0",
    );
    assert.equal(await service.runDueAlarm(), "rearmed");
    assert.deepEqual(writes, [3, 4]);
    assert.equal((await state())["head:last_seen"], 4);
    assert.equal((await state())["head:write_next"], 5);
  });

  it("exclusive global leases fence stale owners and preserve restart state", async () => {
    const first = await createPgChainFirehoseStore(runtime, options),
      second = await createPgChainFirehoseStore(runtime, options);
    const old = (await first.acquire())!;
    assert.equal(await second.acquire(), null);
    await first.save(
      old,
      JSON.stringify({ "head:last_seen": 7, "head:write_next": 4 }),
    );
    await control.query(
      "UPDATE realtime.chain_firehose_actor SET lease_until_ms=0",
    );
    const current = (await second.acquire())!;
    await assert.rejects(first.save(old, "{}"), /ownership/);
    await first.release(old);
    assert.equal(
      (
        await control.query(
          "SELECT owner_token FROM realtime.chain_firehose_actor",
        )
      ).rows[0].owner_token,
      current.token,
    );
    assert.deepEqual(JSON.parse(current.state), {
      "head:last_seen": 7,
      "head:write_next": 4,
    });
    await second.release(current);
  });

  it("retains exact NUL and lone-surrogate membership identifiers as JSON text", async () => {
    const service = await peer();
    const id = "nul\u0000lone\ud800";
    await service.fetch(request("/mcp-subscribe", { sessionId: id }));
    assert.deepEqual((await state())["mcp:subscribed-sessions"], [id]);
  });

  it(
    "the unbundled Node protocol shares GraphQL identity and cancels quiet subscriptions",
    { timeout: 5000 },
    async () => {
      const service = await peer();
      let incoming!: (message: string | ArrayBuffer) => void;
      let onClose: ((code: number, reason: string) => void) | undefined;
      const sent: string[] = [];
      let waiting: ((message: string) => void) | undefined;
      const frame = () =>
        new Promise<string>((resolve) => {
          const queued = sent.shift();
          if (queued !== undefined) resolve(queued);
          else waiting = resolve;
        });
      const socket: NativeChainSocket = {
        bufferedBytes: 0,
        send(message) {
          if (waiting) {
            const resolve = waiting;
            waiting = undefined;
            resolve(message);
          } else sent.push(message);
        },
        close(code, reason) {
          onClose?.(code, reason);
        },
        onMessage(callback) {
          incoming = callback;
        },
        onClose(callback) {
          onClose = callback;
        },
      };
      await service.openSocket(
        new Request("https://chain.invalid/subscribe", {
          headers: { "sec-websocket-protocol": "graphql-transport-ws" },
        }),
        async () => socket,
      );
      incoming(JSON.stringify({ type: "connection_init" }));
      assert.equal(JSON.parse(await frame()).type, "connection_ack");
      incoming(
        JSON.stringify({
          type: "subscribe",
          id: "query",
          payload: { query: "query { __typename }" },
        }),
      );
      assert.equal(JSON.parse(await frame()).type, "error");
      incoming(
        JSON.stringify({
          type: "subscribe",
          id: "events",
          payload: {
            query: "subscription { chainEvents { table block_number } }",
          },
        }),
      );
      await nextTurn();
      assert.equal(service.activeGraphqlSubscriptions, 1);
      await runtime.producer.query("SELECT 1");
      await service.fetch(request("/ingest", block()));
      const next = JSON.parse(await frame());
      assert.equal(next.type, "next");
      assert.deepEqual(next.payload.data.chainEvents, {
        table: "blocks",
        block_number: 3,
      });
      incoming(JSON.stringify({ type: "complete", id: "events" }));
      await nextTurn();
      assert.equal(service.activeGraphqlSubscriptions, 0);
    },
  );

  // #13046 close-out follow-up (a): the slow-client, protocol-limit and
  // alarm-settle-fencing paths had synthetic coverage only; these run them
  // against the real engine so a Postgres-side behavior change cannot hide
  // behind the PGlite fixture.
  const plainSocket = () => {
    const socket = {
      bufferedBytes: 0,
      sent: [] as string[],
      closed: undefined as { code: number; reason: string } | undefined,
      incoming: undefined as
        ((message: string | ArrayBuffer) => void) | undefined,
      send(message: string) {
        socket.sent.push(message);
      },
      close(code: number, reason: string) {
        socket.closed = { code, reason };
      },
      onMessage(callback: (message: string | ArrayBuffer) => void) {
        socket.incoming = callback;
      },
      onClose() {},
    };
    return socket;
  };

  it("a slow client is shed with 1013 while healthy sockets keep receiving", async () => {
    const service = await peer();
    const slow = plainSocket(),
      healthy = plainSocket();
    assert.equal(
      await service.openSocket(
        request("/api/v1/chain/stream"),
        async () => slow,
      ),
      null,
    );
    assert.equal(
      await service.openSocket(
        new Request("https://chain.invalid/api/v1/chain/stream", {
          headers: { "cf-connecting-ip": "198.51.100.9" },
        }),
        async () => healthy,
      ),
      null,
    );
    slow.bufferedBytes = options.maxSocketBufferedBytes + 1;
    assert.equal(
      (await service.fetch(request("/ingest", block()))).status,
      202,
    );
    assert.equal(slow.closed?.code, 1013);
    assert.equal(slow.sent.length, 0);
    assert.match(healthy.sent[0]!, /"block_number":3/);
    assert.equal(service.state, "ready");
  });

  it("an oversized protocol message closes only the offending socket", async () => {
    const service = await peer({ maxSocketMessageBytes: 64 });
    const offender = plainSocket(),
      bystander = plainSocket();
    const graphql = (ip: string) =>
      new Request("https://chain.invalid/subscribe", {
        headers: {
          "sec-websocket-protocol": "graphql-transport-ws",
          "cf-connecting-ip": ip,
        },
      });
    assert.equal(
      await service.openSocket(graphql("198.51.100.7"), async () => offender),
      null,
    );
    assert.equal(
      await service.openSocket(graphql("198.51.100.8"), async () => bystander),
      null,
    );
    bystander.incoming!(JSON.stringify({ type: "connection_init" }));
    offender.incoming!(
      Uint8Array.from(new TextEncoder().encode("x".repeat(65))).buffer,
    );
    assert.equal(offender.closed?.code, 1009);
    assert.equal(bystander.closed, undefined);
    assert.equal(service.state, "ready");
    assert.equal(
      (await service.fetch(request("/ingest", block()))).status,
      202,
    );
  });

  it("stale and forged tokens cannot settle alarms, and retries exhaust finitely", async () => {
    const store = await createPgChainFirehoseStore(runtime, options);
    const owner = (await store.acquire())!;
    await store.setAlarm(owner, 0);
    const old = (await store.claimAlarm(owner))!;
    await control.query(
      "UPDATE realtime.chain_firehose_actor SET lease_until_ms=0",
    );
    const next = (await store.acquire())!;
    await assert.rejects(store.settleAlarm(owner, old, false), /ownership/);
    const current = (await store.claimAlarm(next))!;
    assert.equal(
      await store.settleAlarm(next, { ...current, token: old.token }, false),
      false,
    );
    assert.equal(await store.settleAlarm(next, current, false), true);

    // claimAlarm counts every claim (two so far); only a fresh setAlarm
    // resets the attempt budget, which is what the loop below measures.
    await store.setAlarm(next, 0);
    const outcome = async () =>
      (
        await control.query(
          "SELECT alarm_attempts, alarm_outcome FROM realtime.chain_firehose_actor",
        )
      ).rows[0];
    for (let attempt = 1; attempt <= 6; attempt++) {
      await control.query(
        "UPDATE realtime.chain_firehose_actor SET alarm_at_ms=0",
      );
      const claim = (await store.claimAlarm(next))!;
      assert.equal(await store.settleAlarm(next, claim, true), true);
      const row = await outcome();
      assert.equal(Number(row.alarm_attempts), attempt);
      assert.equal(row.alarm_outcome, attempt === 6 ? "exhausted" : "retry");
    }
    await control.query(
      "UPDATE realtime.chain_firehose_actor SET alarm_at_ms=0",
    );
    assert.equal(await store.claimAlarm(next), null);
    await store.setAlarm(next, 0);
    assert.equal(Number((await outcome()).alarm_attempts), 0);
    await store.release(next);
  });
});
