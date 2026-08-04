// The gap guarantee is the whole point of src/raw-chain-capture.ts, so these
// tests attack it directly: a tick that fails mid-run must NOT advance the
// watermark past the failure, and a later tick must re-capture that exact
// height. A test that only proved the happy path would pass while the module
// silently skipped blocks.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  captureTick,
  fetchRawBlock,
  nextCaptureHeights,
  rawBatchKey,
  SYSTEM_EVENTS_STORAGE_KEY,
  type RawCaptureStore,
  type WatermarkStore,
} from "../src/raw-chain-capture.ts";

/** A fake node. `failAt` makes one height fail, the way a real RPC blip does. */
function rpcFetch(
  opts: {
    head?: number;
    failAt?: number;
    events?: string | null;
    badBlockAt?: number;
    badHashAt?: number;
    badEventsAt?: number;
    headNumber?: unknown;
  } = {},
) {
  const heightOf = (hash: string) => Number(hash.replace("0xh", ""));
  return (async (_url: unknown, init?: { body?: string }) => {
    const req = JSON.parse(init?.body ?? "{}") as {
      method: string;
      params: unknown[];
    };
    const reply = (result: unknown) =>
      ({ ok: true, json: async () => ({ result }) }) as unknown as Response;

    if (req.method === "chain_getHeader") {
      return reply({
        number:
          "headNumber" in opts
            ? opts.headNumber
            : `0x${(opts.head ?? 100).toString(16)}`,
      });
    }
    if (req.method === "chain_getBlockHash") {
      const n = req.params[0] as number;
      if (n === opts.failAt) return { ok: false, status: 500 } as Response;
      if (n === opts.badHashAt) return reply(null);
      return reply(`0xh${n}`);
    }
    if (req.method === "chain_getBlock") {
      const n = heightOf(req.params[0] as string);
      if (n === opts.badBlockAt) return reply({ block: { header: {} } });
      return reply({
        block: {
          header: { parentHash: `0xh${n - 1}`, number: `0x${n.toString(16)}` },
          extrinsics: [`0xext${n}a`, `0xext${n}b`],
        },
      });
    }
    if (req.method === "state_getStorage") {
      assert.equal(req.params[0], SYSTEM_EVENTS_STORAGE_KEY);
      const n = heightOf(req.params[1] as string);
      if (n === opts.badEventsAt) return reply(42);
      return reply(opts.events === undefined ? `0xev${n}` : opts.events);
    }
    return { ok: false, status: 404 } as Response;
  }) as unknown as typeof fetch;
}

function memoryStore() {
  const puts = new Map<string, string>();
  const store: RawCaptureStore = {
    put: async (key, value) => void puts.set(key, value),
  };
  return { store, puts };
}

function memoryWatermark(initial: number | null = null) {
  let value = initial;
  const watermark: WatermarkStore = {
    read: async () => value,
    write: async (v) => void (value = v),
  };
  return { watermark, get: () => value };
}

describe("nextCaptureHeights", () => {
  test("returns the contiguous run from the watermark, never a jump to head", () => {
    assert.deepEqual(nextCaptureHeights(10, 14, 100), [11, 12, 13, 14]);
    assert.deepEqual(
      nextCaptureHeights(10, 10_000, 3),
      [11, 12, 13],
      "bounded by maxPerTick, and starts at the watermark — falling behind is recoverable, skipping is not",
    );
  });

  test("returns nothing when caught up, or when the head is behind us", () => {
    assert.deepEqual(nextCaptureHeights(10, 10, 5), []);
    assert.deepEqual(nextCaptureHeights(10, 4, 5), []);
  });

  test("rejects nonsense bounds rather than guessing", () => {
    assert.deepEqual(nextCaptureHeights(10, -1, 5), []);
    assert.deepEqual(nextCaptureHeights(10, 1.5, 5), []);
    assert.deepEqual(nextCaptureHeights(10, 20, 0), []);
    assert.deepEqual(nextCaptureHeights(10, 20, -3), []);
    assert.deepEqual(nextCaptureHeights(10, 20, 1.5), []);
  });
});

describe("rawBatchKey", () => {
  test("pads so lexicographic order matches block order", () => {
    assert.equal(
      rawBatchKey(9, 12),
      "chain/raw/blocks/000000000009-000000000012.ndjson",
    );
    assert.ok(rawBatchKey(9, 9) < rawBatchKey(10, 10));
    assert.ok(rawBatchKey(99, 99) < rawBatchKey(100, 100));
  });

  test("mainnet keeps the bare prefix, explicitly and by default (#8700)", () => {
    // The decode lane lists `chain/raw/blocks/` and every object captured
    // before networks existed lives there, so this prefix is a compatibility
    // contract, not a naming preference.
    assert.equal(
      rawBatchKey(9, 12, "mainnet"),
      "chain/raw/blocks/000000000009-000000000012.ndjson",
    );
    assert.equal(rawBatchKey(9, 12), rawBatchKey(9, 12, "mainnet"));
  });

  test("testnet writes under its own prefix, so equal heights cannot collide", () => {
    // The key encodes only a block RANGE. Without the prefix, testnet block
    // 7,700,000 and mainnet block 7,700,000 are the same object, and the
    // second write silently replaces the first with another chain's bytes.
    assert.equal(
      rawBatchKey(9, 12, "testnet"),
      "chain/raw/testnet/blocks/000000000009-000000000012.ndjson",
    );
    assert.notEqual(rawBatchKey(9, 12, "testnet"), rawBatchKey(9, 12));
    // Ordering still holds within a network.
    assert.ok(rawBatchKey(9, 9, "testnet") < rawBatchKey(10, 10, "testnet"));
  });
});

describe("fetchRawBlock", () => {
  test("captures header, extrinsics and the events blob verbatim", async () => {
    const block = await fetchRawBlock("https://rpc", 7, rpcFetch(), () => 1234);
    assert.equal(block.block_number, 7);
    assert.equal(block.block_hash, "0xh7");
    assert.equal(block.parent_hash, "0xh6");
    assert.deepEqual(block.extrinsics, ["0xext7a", "0xext7b"]);
    assert.equal(block.events, "0xev7");
    assert.equal(block.captured_at, 1234);
  });

  test("records a pruned events blob as null, distinct from 'no events'", async () => {
    const block = await fetchRawBlock(
      "https://rpc",
      7,
      rpcFetch({ events: null }),
    );
    assert.equal(block.events, null);
  });

  test("throws rather than returning a partial capture", async () => {
    await assert.rejects(
      fetchRawBlock("https://rpc", 5, rpcFetch({ badHashAt: 5 })),
      /no hash at height 5/,
    );
    await assert.rejects(
      fetchRawBlock("https://rpc", 5, rpcFetch({ badBlockAt: 5 })),
      /malformed block at height 5/,
    );
    await assert.rejects(
      fetchRawBlock("https://rpc", 5, rpcFetch({ badEventsAt: 5 })),
      /malformed events at height 5/,
    );
    await assert.rejects(
      fetchRawBlock("https://rpc", 5, rpcFetch({ failAt: 5 })),
      /HTTP 500/,
    );
  });

  test("a non-string extrinsic is refused, not coerced", async () => {
    const bad = (async () =>
      ({
        ok: true,
        json: async () => ({
          result: { block: { header: { parentHash: "0xp" }, extrinsics: [1] } },
        }),
      }) as unknown as Response) as unknown as typeof fetch;
    const mixed = (async (url: unknown, init?: { body?: string }) => {
      const m = JSON.parse(init?.body ?? "{}").method;
      if (m === "chain_getBlockHash")
        return {
          ok: true,
          json: async () => ({ result: "0xh5" }),
        } as unknown as Response;
      return bad(url as never, init as never);
    }) as unknown as typeof fetch;
    await assert.rejects(
      fetchRawBlock("https://rpc", 5, mixed),
      /non-string extrinsic/,
    );
  });

  test("a non-string parentHash degrades to empty rather than throwing", async () => {
    const noParent = (async (_u: unknown, init?: { body?: string }) => {
      const m = JSON.parse(init?.body ?? "{}").method;
      const reply = (result: unknown) =>
        ({ ok: true, json: async () => ({ result }) }) as unknown as Response;
      if (m === "chain_getBlockHash") return reply("0xh5");
      if (m === "chain_getBlock")
        return reply({ block: { header: {}, extrinsics: [] } });
      return reply("0xev5");
    }) as unknown as typeof fetch;
    const block = await fetchRawBlock("https://rpc", 5, noParent);
    assert.equal(
      block.parent_hash,
      "",
      "the block is still captured -- a missing parentHash must not cost us the bytes",
    );
  });

  test("a thrown non-Error is still recorded as a reason", async () => {
    const { store } = memoryStore();
    const { watermark, get } = memoryWatermark(99);
    const throwsString = (async (_u: unknown, init?: { body?: string }) => {
      const m = JSON.parse(init?.body ?? "{}").method;
      if (m === "chain_getHeader")
        return {
          ok: true,
          json: async () => ({ result: { number: "0x6e" } }),
        } as unknown as Response;
      throw "plain string failure";
    }) as unknown as typeof fetch;
    const result = await captureTick({
      rpcUrl: "https://rpc",
      store,
      watermark,
      genesisFloor: 0,
      maxPerTick: 3,
      fetchImpl: throwsString,
    });
    assert.equal(result.captured, 0);
    assert.equal(result.reason, "plain string failure");
    assert.equal(get(), 99);
  });

  test("surfaces a JSON-RPC error body", async () => {
    const erroring = (async () =>
      ({
        ok: true,
        json: async () => ({ error: { message: "boom" } }),
      }) as unknown as Response) as unknown as typeof fetch;
    await assert.rejects(fetchRawBlock("https://rpc", 1, erroring), /boom/);
  });
});

describe("captureTick — the no-gap guarantee", () => {
  test("first tick starts AT the floor, not after it", async () => {
    const { store, puts } = memoryStore();
    const { watermark, get } = memoryWatermark(null);
    const result = await captureTick({
      rpcUrl: "https://rpc",
      store,
      watermark,
      genesisFloor: 50,
      maxPerTick: 3,
      fetchImpl: rpcFetch({ head: 60 }),
    });
    assert.equal(result.captured, 3);
    assert.equal(get(), 52);
    assert.ok(puts.has(rawBatchKey(50, 52)), "batch starts at the floor block");
  });

  test("a mid-run failure keeps the prefix and does NOT advance past it", async () => {
    const { store, puts } = memoryStore();
    const { watermark, get } = memoryWatermark(99);
    const result = await captureTick({
      rpcUrl: "https://rpc",
      store,
      watermark,
      genesisFloor: 0,
      maxPerTick: 10,
      fetchImpl: rpcFetch({ head: 110, failAt: 103 }),
    });
    assert.equal(result.captured, 3, "100,101,102 captured");
    assert.equal(result.stoppedAt, 103);
    assert.equal(
      get(),
      102,
      "watermark stops one BELOW the failure so the next tick retries it",
    );
    assert.ok(puts.has(rawBatchKey(100, 102)));
    assert.ok(
      !puts.has(rawBatchKey(100, 109)),
      "no batch claims blocks that were never fetched",
    );
  });

  test("the next tick re-captures exactly the failed height — no hole", async () => {
    const { store, puts } = memoryStore();
    const { watermark, get } = memoryWatermark(99);
    const failing = {
      rpcUrl: "https://rpc",
      store,
      watermark,
      genesisFloor: 0,
      maxPerTick: 10,
    };
    await captureTick({
      ...failing,
      fetchImpl: rpcFetch({ head: 110, failAt: 103 }),
    });
    assert.equal(get(), 102);
    // The blip clears; the retry must resume at 103, not at 104 or at head.
    const second = await captureTick({
      ...failing,
      fetchImpl: rpcFetch({ head: 110 }),
    });
    assert.equal(second.watermark, 110);
    const keys = [...puts.keys()].sort();
    assert.deepEqual(keys, [rawBatchKey(100, 102), rawBatchKey(103, 110)]);
    // Every height in [100,110] appears exactly once across the batches.
    const seen = [...puts.values()]
      .flatMap((v) => v.trim().split("\n"))
      .map((line) => JSON.parse(line).block_number as number)
      .sort((a, b) => a - b);
    assert.deepEqual(
      seen,
      Array.from({ length: 11 }, (_, i) => 100 + i),
      "contiguous, no duplicates, no holes",
    );
  });

  test("a failure on the FIRST height writes nothing and holds the watermark", async () => {
    const { store, puts } = memoryStore();
    const { watermark, get } = memoryWatermark(99);
    const result = await captureTick({
      rpcUrl: "https://rpc",
      store,
      watermark,
      genesisFloor: 0,
      maxPerTick: 5,
      fetchImpl: rpcFetch({ head: 110, failAt: 100 }),
    });
    assert.equal(result.captured, 0);
    assert.equal(result.watermark, 99);
    assert.equal(result.stoppedAt, 100);
    assert.ok(result.reason);
    assert.equal(get(), 99, "watermark unmoved");
    assert.equal(puts.size, 0, "nothing written");
  });

  test("caught up: no work, and `behind` reports zero", async () => {
    const { store, puts } = memoryStore();
    const { watermark } = memoryWatermark(110);
    const result = await captureTick({
      rpcUrl: "https://rpc",
      store,
      watermark,
      genesisFloor: 0,
      maxPerTick: 5,
      fetchImpl: rpcFetch({ head: 110 }),
    });
    assert.deepEqual(result, { captured: 0, watermark: 110, behind: 0 });
    assert.equal(puts.size, 0);
  });

  test("reports how far behind the head it still is, so lag is queryable", async () => {
    const { store, watermark } = { ...memoryStore(), ...memoryWatermark(0) };
    const result = await captureTick({
      rpcUrl: "https://rpc",
      store,
      watermark,
      genesisFloor: 0,
      maxPerTick: 5,
      fetchImpl: rpcFetch({ head: 1000 }),
    });
    assert.equal(result.captured, 5);
    assert.equal(result.watermark, 5);
    assert.equal(result.behind, 995);
  });

  test("a non-integer stored watermark falls back to the floor", async () => {
    const { store } = memoryStore();
    const watermark: WatermarkStore = {
      read: async () => 1.5 as unknown as number,
      write: async () => undefined,
    };
    const result = await captureTick({
      rpcUrl: "https://rpc",
      store,
      watermark,
      genesisFloor: 20,
      maxPerTick: 2,
      fetchImpl: rpcFetch({ head: 30 }),
    });
    assert.equal(result.watermark, 21, "resumed from the floor, not from 1.5");
  });

  test("an unusable head number throws instead of capturing garbage", async () => {
    const { store, watermark } = { ...memoryStore(), ...memoryWatermark(0) };
    await assert.rejects(
      captureTick({
        rpcUrl: "https://rpc",
        store,
        watermark,
        genesisFloor: 0,
        maxPerTick: 5,
        fetchImpl: rpcFetch({ headNumber: "not-hex" }),
      }),
      /unusable head number/,
    );
  });

  test("uses the real fetch/now defaults when none are injected", async () => {
    const { store } = memoryStore();
    const { watermark } = memoryWatermark(5);
    const realFetch = globalThis.fetch;
    globalThis.fetch = rpcFetch({ head: 6 });
    try {
      const result = await captureTick({
        rpcUrl: "https://rpc",
        store,
        watermark,
        genesisFloor: 0,
        maxPerTick: 2,
      });
      assert.equal(result.captured, 1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// #9430. The whole point of chunked flushing is what survives an invocation
// that does NOT finish, so these assert the durability boundary rather than
// the happy path.
describe("captureTick flushes in chunks", () => {
  function chunkedDeps(opts: {
    heights: number;
    flushEvery?: number;
    minGapMs?: number;
    failAt?: number;
  }) {
    const puts: { key: string; lines: number }[] = [];
    const marks: number[] = [];
    const gaps: number[] = [];
    return {
      puts,
      marks,
      gaps,
      deps: {
        rpcUrl: "https://rpc.invalid",
        genesisFloor: 100,
        maxPerTick: opts.heights,
        flushEvery: opts.flushEvery,
        minGapMs: opts.minGapMs ?? 0,
        sleepFn: async (ms: number) => {
          gaps.push(ms);
        },
        store: {
          put: async (key: string, value: string) => {
            puts.push({ key, lines: value.trimEnd().split("\n").length });
          },
        },
        watermark: {
          read: async () => 99,
          write: async (n: number) => {
            marks.push(n);
          },
        },
        now: () => 1,
        fetchImpl: rpcFetch({
          head: 100 + opts.heights,
          ...(opts.failAt ? { failAt: opts.failAt } : {}),
        }),
      },
    };
  }

  test("writes one object per chunk, and the watermark trails each", async () => {
    const { puts, marks, deps } = chunkedDeps({ heights: 10, flushEvery: 4 });
    const result = await captureTick(deps as never);
    assert.equal(result.captured, 10);
    // 4 + 4 + 2, the last being the remainder.
    assert.deepEqual(
      puts.map((p) => p.lines),
      [4, 4, 2],
    );
    // BYTES FIRST, WATERMARK AFTER -- one mark per chunk, each naming that
    // chunk's last block, so the watermark never claims a height whose object
    // is not already durable.
    assert.deepEqual(marks, [103, 107, 109]);
    assert.equal(result.watermark, 109);
  });

  // The property the whole change rests on: a tick that dies mid-way keeps
  // everything it flushed, and the watermark points at exactly that.
  test("a failure keeps every flushed chunk and claims no more", async () => {
    const { puts, marks, deps } = chunkedDeps({
      heights: 10,
      flushEvery: 3,
      failAt: 106,
    });
    const result = await captureTick(deps as never);
    // 100-102 and 103-105 landed; 106 failed, so nothing beyond it is claimed.
    assert.deepEqual(
      puts.map((p) => p.lines),
      [3, 3],
    );
    assert.deepEqual(marks, [102, 105]);
    assert.equal(result.watermark, 105);
    assert.equal(result.stoppedAt, 106);
    assert.equal(result.captured, 6);
  });

  test("a failure before any chunk flushes claims nothing at all", async () => {
    const { puts, marks, deps } = chunkedDeps({
      heights: 10,
      flushEvery: 5,
      failAt: 100,
    });
    const result = await captureTick(deps as never);
    assert.deepEqual(puts, []);
    assert.deepEqual(marks, []);
    assert.equal(result.captured, 0);
    assert.equal(result.watermark, 99, "the watermark must not move");
  });

  // A retry re-reads from the same watermark, so it rebuilds the same chunk
  // boundaries and overwrites byte-for-byte rather than appending a duplicate.
  test("a retry of an unflushed range reproduces the same key", async () => {
    const first = chunkedDeps({ heights: 6, flushEvery: 3 });
    await captureTick(first.deps as never);
    const second = chunkedDeps({ heights: 6, flushEvery: 3 });
    await captureTick(second.deps as never);
    assert.deepEqual(
      first.puts.map((p) => p.key),
      second.puts.map((p) => p.key),
    );
  });

  test("without flushEvery it writes once, exactly as before", async () => {
    const { puts, marks, deps } = chunkedDeps({ heights: 7 });
    await captureTick(deps as never);
    assert.equal(puts.length, 1);
    assert.equal(puts[0]!.lines, 7);
    assert.deepEqual(marks, [106]);
  });

  test("pacing waits between blocks, never before the first", async () => {
    const { gaps, deps } = chunkedDeps({ heights: 4, minGapMs: 4500 });
    const result = await captureTick(deps as never);
    assert.equal(result.captured, 4);
    assert.deepEqual(gaps, [4500, 4500, 4500]);
  });

  test("the default sleep is a real timer, not a no-op", async () => {
    // Every other test injects one, so without this the shipped pacing would be
    // exercised by nothing. One millisecond: this is about the wiring.
    const { deps } = chunkedDeps({ heights: 3, minGapMs: 20 });
    const { sleepFn: _injected, ...shipped } = deps as Record<string, unknown>;
    const started = Date.now();
    const result = await captureTick(shipped as never);
    assert.equal(result.captured, 3);
    // Two gaps between three blocks, so at least ~40ms of real waiting.
    assert.ok(
      Date.now() - started >= 30,
      "the shipped pacing did not actually wait",
    );
  });
});
