import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createNativeChainHeadSource,
  type NativeChainHeadOptions,
} from "../src/native-chain-head.ts";
import type { PgStoreRuntime } from "../src/pg-store-runtime.ts";

function fixture(overrides: Partial<NativeChainHeadOptions> = {}) {
  const calls: { method: string; params: unknown[] }[] = [];
  const writes: { text: string; values?: unknown[] }[] = [];
  const runtime: Pick<PgStoreRuntime, "producer"> = {
    producer: {
      query: async <Row>(text: string, values?: unknown[]) => {
        writes.push({ text, values });
        return [] as Row[];
      },
      first: async () => null,
      run: async () => ({ changes: 0 }),
      transaction: async () => [],
    },
  };
  const options: NativeChainHeadOptions = {
    rpcUrl: "https://chain.fixture.invalid",
    requestTimeoutMillis: 1000,
    withAuthor: false,
    withEventCount: false,
    now: () => 1234,
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      calls.push(body);
      const result =
        body.method === "chain_getHeader"
          ? { number: "0x7" }
          : body.method === "chain_getBlockHash"
            ? "0x01"
            : body.method === "chain_getBlock"
              ? { block: { header: { parentHash: "0x00" }, extrinsics: [] } }
              : null;
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, result }),
        { headers: { "content-type": "application/json" } },
      );
    },
    ...overrides,
  };
  return {
    runtime,
    options,
    calls,
    writes,
    source: createNativeChainHeadSource(runtime, options),
  };
}

test("native head construction has explicit origin and finite transport controls without I/O", () => {
  const f = fixture();
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.writes, []);
  for (const rpcUrl of [
    "file:///tmp/chain",
    "https://user:pass@chain.invalid",
    "https://chain.invalid/#fragment",
  ])
    assert.throws(() =>
      createNativeChainHeadSource(f.runtime, { ...f.options, rpcUrl }),
    );
  for (const requestTimeoutMillis of [0, 60001, NaN])
    assert.throws(() =>
      createNativeChainHeadSource(f.runtime, {
        ...f.options,
        requestTimeoutMillis,
      }),
    );
  for (const key of ["fetch", "now"])
    assert.throws(() =>
      createNativeChainHeadSource(f.runtime, { ...f.options, [key]: null }),
    );
});

test("head reads and writes retain source validation and the original guarded upsert", async () => {
  const f = fixture(),
    signal = new AbortController().signal;
  assert.equal(await f.source.head(signal), 7);
  const block = await f.source.block(7, signal);
  assert.equal(block.observed_at, 1234);
  assert.equal(block.block_number, 7);
  assert.equal(block.event_count, null);
  assert.equal(block.author, null);
  await f.source.write(block, signal);
  assert.match(
    f.writes[0]!.text,
    /event_count=COALESCE\(excluded.event_count, blocks_head.event_count\)/,
  );
  assert.match(
    f.writes[0]!.text,
    /author=COALESCE\(excluded.author, blocks_head.author\)/,
  );
  assert.deepEqual(f.writes[0]!.values, [
    7,
    "0x01",
    "0x00",
    0,
    null,
    null,
    1234,
  ]);
  assert.deepEqual(
    f.calls.map((call) => call.method),
    ["chain_getHeader", "chain_getBlockHash", "chain_getBlock"],
  );
});

test("request cancellation reaches the RPC transport and prevents a canceled write", async () => {
  const abort = new AbortController();
  let sent = false;
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const f = fixture({
    fetch: async (_input, init) => {
      sent = true;
      enter();
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener(
          "abort",
          () => reject(init!.signal!.reason),
          { once: true },
        );
      });
    },
  });
  const pending = f.source.head(abort.signal);
  const rejected = assert.rejects(pending, /request canceled/);
  await entered;
  abort.abort(new Error("request canceled"));
  await rejected;
  assert.equal(sent, true);
  await assert.rejects(
    f.source.write(
      {
        table: "blocks",
        block_number: 7,
        block_hash: "0x01",
        parent_hash: "0x00",
        extrinsic_count: 0,
        event_count: null,
        author: null,
        observed_at: 1234,
      },
      abort.signal,
    ),
    /request canceled/,
  );
  assert.deepEqual(f.writes, []);
});

test("an uncommitted database write cannot advance the head source", async () => {
  const f = fixture();
  f.runtime.producer.query = async () => {
    throw new Error("database unavailable");
  };
  const block = await f.source.block(7, new AbortController().signal);
  await assert.rejects(
    f.source.write(block, new AbortController().signal),
    /write was not committed/,
  );
});
