// The firehose head poller (#204): src/head-poller.ts's pure logic, plus the
// hub's alarm/poll-start wiring with a storage-stubbed DO state.
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  fetchBlockAt,
  fetchHeadNumber,
  heightsToEmit,
  hexToNumber,
} from "../src/head-poller.ts";
import { ChainFirehoseHub } from "../workers/chain-firehose-hub.ts";

const rpcFetch = (handlers: Record<string, (params: unknown[]) => unknown>) =>
  (async (_url: unknown, init?: { body?: string }) => {
    const req = JSON.parse(init?.body ?? "{}") as {
      method: string;
      params: unknown[];
    };
    const handler = handlers[req.method];
    if (!handler) return { ok: false, status: 404 } as Response;
    return {
      ok: true,
      json: async () => ({ result: handler(req.params) }),
    } as unknown as Response;
  }) as typeof fetch;

test("hexToNumber parses hex quantities and rejects garbage", () => {
  assert.equal(hexToNumber("0x85918e"), 8_753_550);
  for (const bad of [null, 42, "85918e", "0xzz"]) {
    assert.throws(() => hexToNumber(bad));
  }
});

test("fetchHeadNumber reads the head height from chain_getHeader", async () => {
  const head = await fetchHeadNumber(
    "https://rpc.example",
    rpcFetch({ chain_getHeader: () => ({ number: "0x10" }) }),
  );
  assert.equal(head, 16);
});

test("fetchBlockAt assembles a scalar blocks payload", async () => {
  const block = await fetchBlockAt(
    "https://rpc.example",
    16,
    rpcFetch({
      chain_getBlockHash: (params) => {
        assert.deepEqual(params, [16]);
        return "0xabc";
      },
      chain_getBlock: () => ({
        block: { header: { parentHash: "0xdef" }, extrinsics: [1, 2, 3] },
      }),
    }),
    () => 1_000,
  );
  assert.deepEqual(block, {
    table: "blocks",
    block_number: 16,
    block_hash: "0xabc",
    parent_hash: "0xdef",
    extrinsic_count: 3,
    observed_at: 1_000,
  });
});

test("fetchBlockAt surfaces RPC failures rather than fabricating a block", async () => {
  await assert.rejects(
    fetchBlockAt(
      "https://rpc.example",
      16,
      rpcFetch({ chain_getBlockHash: () => null }),
    ),
    /no hash at height/,
  );
  await assert.rejects(
    fetchBlockAt("https://rpc.example", 16, (async () => ({
      ok: false,
      status: 500,
    })) as unknown as typeof fetch),
    /HTTP 500/,
  );
  await assert.rejects(
    fetchHeadNumber("https://rpc.example", (async () => ({
      ok: true,
      json: async () => ({ error: { message: "nope" } }),
    })) as unknown as typeof fetch),
    /nope/,
  );
});

test("heightsToEmit: live-from-now start, steady advance, bounded catch-up", () => {
  assert.deepEqual(
    heightsToEmit(null, 100),
    [100],
    "first tick starts AT head",
  );
  assert.deepEqual(heightsToEmit(100, 100), [], "caught up");
  assert.deepEqual(
    heightsToEmit(100, 99),
    [],
    "head behind us (reorg/lagging node)",
  );
  assert.deepEqual(heightsToEmit(100, 102), [101, 102], "normal advance");
  const burst = heightsToEmit(0, 1000, 25);
  assert.equal(burst.length, 25, "catch-up capped");
  assert.equal(burst[24], 1000, "always reaches the head");
  assert.deepEqual(heightsToEmit(5, -1), [], "garbage head emits nothing");
});

// --- hub wiring ---

function hubWith(env: Record<string, unknown>, storage: Map<string, unknown>) {
  let alarmAt: number | null = null;
  const state = {
    getWebSockets: () => [],
    storage: {
      get: async (k: string) => storage.get(k),
      put: async (k: string, v: unknown) => void storage.set(k, v),
      getAlarm: async () => alarmAt,
      setAlarm: async (t: number) => void (alarmAt = t),
    },
  };
  const hub = new ChainFirehoseHub(state as never, env as never);
  return { hub, state, alarm: () => alarmAt };
}

test("poll-start arms the alarm once and is idempotent", async () => {
  const { hub, alarm } = hubWith({}, new Map());
  const first = await hub.fetch(
    new Request("https://x/poll-start", { method: "POST" }),
  );
  assert.deepEqual(await first.json(), { ok: true, armed: true });
  const armedAt = alarm();
  assert.ok(armedAt !== null);
  const second = await hub.fetch(
    new Request("https://x/poll-start", { method: "POST" }),
  );
  assert.deepEqual(await second.json(), { ok: true, armed: false });
  assert.equal(alarm(), armedAt, "existing alarm untouched");
});

test("alarm: kill switch off -> no polling, but always re-arms", async () => {
  const { hub, alarm } = hubWith(
    { CHAIN_HEAD_POLL_ENABLED: "false" },
    new Map(),
  );
  await hub.alarm();
  assert.ok(alarm() !== null, "re-armed even while disabled");
});

test("alarm: broadcasts and durably records each new block, advancing last_seen", async () => {
  const storage = new Map<string, unknown>();
  storage.set("head:last_seen", 14);
  const d1Writes: unknown[][] = [];
  const env = {
    CHAIN_HEAD_POLL_ENABLED: "true",
    CHAIN_HEAD_RPC_URL: "https://rpc.example",
    METAGRAPH_HEALTH_DB: {
      prepare: () => ({
        bind: (...values: unknown[]) => ({
          run: async () => void d1Writes.push(values),
        }),
      }),
    },
  };
  const { hub, alarm } = hubWith(env, storage);
  const seen: unknown[] = [];
  (hub as unknown as { broadcast: (p: unknown) => Promise<void> }).broadcast =
    async (p) => void seen.push(p);
  const realFetch = globalThis.fetch;
  globalThis.fetch = rpcFetch({
    chain_getHeader: () => ({ number: "0x10" }),
    chain_getBlockHash: (params) => `0xhash${(params as number[])[0]}`,
    chain_getBlock: () => ({
      block: { header: { parentHash: "0xp" }, extrinsics: [1] },
    }),
  });
  try {
    await hub.alarm();
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(seen.length, 2, "blocks 15 and 16 broadcast");
  assert.equal((seen[1] as { block_number: number }).block_number, 16);
  assert.equal(d1Writes.length, 2, "both blocks written to D1");
  assert.equal(storage.get("head:last_seen"), 16);
  assert.ok(alarm() !== null, "re-armed");
});

test("alarm: an RPC failure is contained and the chain re-arms", async () => {
  const { hub, alarm } = hubWith(
    {
      CHAIN_HEAD_POLL_ENABLED: "true",
      CHAIN_HEAD_RPC_URL: "https://rpc.example",
    },
    new Map(),
  );
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("rpc down");
  }) as unknown as typeof fetch;
  try {
    await hub.alarm();
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(alarm() !== null, "re-armed after failure");
});

test("alarm: a repeating failure captures ONE $exception; a changed failure captures again", async () => {
  const { hub, alarm } = hubWith(
    {
      CHAIN_HEAD_POLL_ENABLED: "true",
      CHAIN_HEAD_RPC_URL: "https://rpc.example",
      POSTHOG_PROJECT_TOKEN: "phc_test",
    },
    new Map(),
  );
  const captures: { event?: string; properties?: { route?: string } }[] = [];
  let rpcFailure = "rpc down";
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
    if (String(url).includes("/i/v0/e/")) {
      captures.push(JSON.parse(init?.body ?? "{}"));
      return { ok: true } as unknown as Response;
    }
    throw new Error(rpcFailure);
  }) as typeof fetch;
  try {
    await hub.alarm();
    await hub.alarm();
    assert.equal(captures.length, 1, "identical failure is captured once");
    assert.equal(captures[0]?.event, "$exception");
    assert.equal(captures[0]?.properties?.route, "head-poller");
    rpcFailure = "name resolution failed";
    await hub.alarm();
    assert.equal(captures.length, 2, "a DIFFERENT failure is captured again");
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(alarm() !== null, "re-armed throughout");
});
