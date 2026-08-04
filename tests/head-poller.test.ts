// The firehose head poller (#204): src/head-poller.ts's pure logic, plus the
// hub's alarm/poll-start wiring with a storage-stubbed DO state.
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  fetchBlockAt,
  fetchEventCountAt,
  fetchHeadNumber,
  heightsToEmit,
  hexToNumber,
  scaleCompactLength,
  SYSTEM_EVENTS_STORAGE_KEY,
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
    // Opt-in (#9417): this call did not ask for the count, so no extra
    // state_getStorage was spent and the field is an honest null.
    event_count: null,
    observed_at: 1_000,
  });
});

// #9417 -- the count is readable WITHOUT metadata or decoding, because a SCALE
// `Vec` carries its length as a compact prefix.
//
// Proven by ROUND TRIP against an encoder written to the SCALE spec, not
// against hand-picked hex: a hand-computed vector is one typo away from
// asserting the bug, and it only ever covers the values someone thought of.
// The three real on-chain counts are pinned separately below.
function encodeCompact(n: number): string {
  if (n < 1 << 6) return "0x" + ((n << 2) & 0xff).toString(16).padStart(2, "0");
  const bytes: number[] = [];
  if (n < 1 << 14) {
    const v = (n << 2) | 0b01;
    bytes.push(v & 0xff, (v >> 8) & 0xff);
  } else if (n < 1 << 30) {
    const v = ((n << 2) | 0b10) >>> 0;
    bytes.push(
      v & 0xff,
      (v >>> 8) & 0xff,
      (v >>> 16) & 0xff,
      (v >>> 24) & 0xff,
    );
  } else {
    // big-integer mode: (len-4) << 2 | 0b11, then `len` LE bytes.
    const le: number[] = [];
    let rest = n;
    while (rest > 0) {
      le.push(rest % 256);
      rest = Math.floor(rest / 256);
    }
    while (le.length < 4) le.push(0);
    bytes.push(((le.length - 4) << 2) | 0b11, ...le);
  }
  return "0x" + bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

test("scaleCompactLength round-trips every compact mode", () => {
  for (const n of [
    0,
    1,
    63, // single-byte mode, and its boundary
    64,
    320,
    268,
    256,
    16383, // two-byte mode (real event counts live here)
    16384,
    1 << 20,
    (1 << 30) - 1, // four-byte mode, to its ceiling
    1 << 30,
    2 ** 32, // big-integer mode
  ]) {
    assert.equal(
      scaleCompactLength(encodeCompact(n)),
      n,
      `round trip for ${n}`,
    );
  }
});

// The three blocks this feature was verified against on the live archive
// endpoint. Pinned as bytes so a regression in the reader is caught even if
// the encoder above were wrong in the same direction.
test("scaleCompactLength matches the counts verified on mainnet", () => {
  for (const [hex, count, block] of [
    ["0x0105", 320, 8_771_446],
    ["0x3104", 268, 8_771_000],
    ["0x0104", 256, 8_771_459],
  ] as const) {
    assert.equal(scaleCompactLength(hex), count, `block ${block}`);
  }
});

test("scaleCompactLength returns null on anything it cannot trust", () => {
  for (const bad of [
    undefined,
    null,
    42,
    "",
    "0x",
    "not-hex",
    "0xzz",
    "0x0", // odd nibble count
    "0x01", // two-byte mode with no second byte
    "0x02ff", // four-byte mode, truncated
  ]) {
    assert.equal(
      scaleCompactLength(bad),
      null,
      `${String(bad)} should be null`,
    );
  }
});

test("fetchEventCountAt reads System.Events at the block hash", async () => {
  let askedKey;
  let askedHash;
  const n = await fetchEventCountAt(
    "https://rpc.example",
    "0xabc",
    rpcFetch({
      state_getStorage: (params) => {
        [askedKey, askedHash] = params as [string, string];
        return "0x0105"; // 320
      },
    }),
  );
  assert.equal(n, 320);
  assert.equal(askedKey, SYSTEM_EVENTS_STORAGE_KEY);
  assert.equal(askedHash, "0xabc");
});

// The count is a nice-to-have; the block row is not. Every failure mode below
// must degrade to null rather than throw, or one bad storage read would cost
// us the height itself.
test("fetchEventCountAt degrades to null, never throws", async () => {
  const rejects = (async () => {
    throw new Error("boom");
  }) as unknown as typeof fetch;
  assert.equal(
    await fetchEventCountAt("https://rpc.example", "0xabc", rejects),
    null,
  );
  assert.equal(
    await fetchEventCountAt(
      "https://rpc.example",
      "0xabc",
      rpcFetch({ state_getStorage: () => "garbage" }),
    ),
    null,
  );
});

// An empty key is a REAL zero -- the block genuinely emitted no events --
// and must not be confused with the null an unreadable read produces.
test("fetchEventCountAt reads an absent key as a real zero", async () => {
  assert.equal(
    await fetchEventCountAt(
      "https://rpc.example",
      "0xabc",
      rpcFetch({ state_getStorage: () => null }),
    ),
    0,
  );
});

test("fetchBlockAt spends the extra read only when asked", async () => {
  const calls: string[] = [];
  const fetchImpl = rpcFetch({
    chain_getBlockHash: () => "0xabc",
    chain_getBlock: () => ({
      block: { header: { parentHash: "0xdef" }, extrinsics: [] },
    }),
    state_getStorage: () => "0x0105",
  });
  const counting = (async (url: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)).method);
    return fetchImpl(url as string, init);
  }) as unknown as typeof fetch;

  const withCount = await fetchBlockAt(
    "https://rpc.example",
    16,
    counting,
    () => 1,
    true,
  );
  assert.equal(withCount.event_count, 320);
  assert.deepEqual(calls, [
    "chain_getBlockHash",
    "chain_getBlock",
    "state_getStorage",
  ]);

  calls.length = 0;
  const without = await fetchBlockAt(
    "https://rpc.example",
    16,
    counting,
    () => 1,
  );
  assert.equal(without.event_count, null);
  assert.deepEqual(calls, ["chain_getBlockHash", "chain_getBlock"]);
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
