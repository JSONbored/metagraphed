// The gap guarantee is the whole point of src/raw-chain-capture.ts, so these
// tests attack it directly: a tick that fails mid-run must NOT advance the
// watermark past the failure, and a later tick must re-capture that exact
// height. A test that only proved the happy path would pass while the module
// silently skipped blocks.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  captureTick,
  fetchRawBlockChunk,
  nextCaptureHeights,
  rawBatchKey,
  SYSTEM_EVENTS_STORAGE_KEY,
  type RawCaptureStore,
  type WatermarkStore,
} from "../src/raw-chain-capture.ts";

/**
 * A fake node that speaks what the real one speaks: `chain_getBlockHash` over
 * a LIST of heights, and JSON-RPC BATCH request bodies.
 *
 * The two failure options are deliberately different kinds of event, because
 * the module treats them differently and the difference is the guarantee:
 *   - `failAt` is a per-CALL error, what a node returns for a height it cannot
 *     serve. The chunk keeps its prefix and stops there.
 *   - `httpFailAt` fails the whole REQUEST, so the chunk is lost entirely and
 *     the caller must rotate to another endpoint.
 */
function rpcFetch(
  opts: {
    head?: number;
    failAt?: number;
    httpFailAt?: number;
    events?: string | null;
    badBlockAt?: number;
    badHashAt?: number;
    badEventsAt?: number;
    headNumber?: unknown;
    /** Answer batches in reverse, to prove correlation is by id not position. */
    shuffle?: boolean;
  } = {},
) {
  const heightOf = (hash: string) => Number(hash.replace("0xh", ""));
  /** Heights a call touches, so a transport failure can be aimed at one. */
  const touches = (method: string, params: unknown[]): number[] => {
    if (method === "chain_getBlockHash") {
      const first = params[0];
      return (Array.isArray(first) ? first : [first]) as number[];
    }
    if (method === "chain_getBlock") return [heightOf(params[0] as string)];
    if (method === "state_getStorage") return [heightOf(params[1] as string)];
    return [];
  };
  /** One call's envelope, exactly as the node would answer it. */
  const answer = (
    method: string,
    params: unknown[],
  ): { result?: unknown; error?: { message: string } } => {
    if (method === "chain_getHeader") {
      return {
        result: {
          number:
            "headNumber" in opts
              ? opts.headNumber
              : `0x${(opts.head ?? 100).toString(16)}`,
        },
      };
    }
    if (method === "chain_getBlockHash") {
      const first = params[0];
      const wanted = (Array.isArray(first) ? first : [first]) as number[];
      const hashes = wanted.map((n) =>
        n === opts.badHashAt ? null : `0xh${n}`,
      );
      // A list request is answered with a list; a bare one with a bare value.
      return { result: Array.isArray(first) ? hashes : hashes[0] };
    }
    if (method === "chain_getBlock") {
      const n = heightOf(params[0] as string);
      if (n === opts.failAt) {
        return { error: { message: `state already discarded at ${n}` } };
      }
      if (n === opts.badBlockAt) return { result: { block: { header: {} } } };
      return {
        result: {
          block: {
            header: {
              parentHash: `0xh${n - 1}`,
              number: `0x${n.toString(16)}`,
            },
            extrinsics: [`0xext${n}a`, `0xext${n}b`],
          },
        },
      };
    }
    if (method === "state_getStorage") {
      assert.equal(params[0], SYSTEM_EVENTS_STORAGE_KEY);
      const n = heightOf(params[1] as string);
      if (n === opts.badEventsAt) return { result: 42 };
      return { result: opts.events === undefined ? `0xev${n}` : opts.events };
    }
    return { error: { message: `unknown method ${method}` } };
  };

  return (async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? "{}") as
      | { method: string; params: unknown[] }
      | { id: number; method: string; params: unknown[] }[];
    const calls = Array.isArray(body) ? body : [body];
    if (
      opts.httpFailAt !== undefined &&
      calls.some((c) => touches(c.method, c.params).includes(opts.httpFailAt!))
    ) {
      return { ok: false, status: 500 } as Response;
    }
    if (!Array.isArray(body)) {
      return {
        ok: true,
        json: async () => answer(body.method, body.params),
      } as unknown as Response;
    }
    const replies = body.map((call) => ({
      id: call.id,
      ...answer(call.method, call.params),
    }));
    return {
      ok: true,
      json: async () => (opts.shuffle ? replies.reverse() : replies),
    } as unknown as Response;
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

describe("fetchRawBlockChunk", () => {
  test("captures header, extrinsics and the events blob verbatim", async () => {
    const { blocks } = await fetchRawBlockChunk(
      "https://rpc",
      [7],
      rpcFetch(),
      () => 1234,
    );
    const block = blocks[0]!;
    assert.equal(block.block_number, 7);
    assert.equal(block.block_hash, "0xh7");
    assert.equal(block.parent_hash, "0xh6");
    assert.deepEqual(block.extrinsics, ["0xext7a", "0xext7b"]);
    assert.equal(block.events, "0xev7");
    assert.equal(block.captured_at, 1234);
  });

  test("reads a whole run in TWO requests, however many blocks", async () => {
    // The point of the chunk. Three requests per block is what capped the lane
    // at ~33 blocks/minute against a limit that counts round trips.
    let requests = 0;
    const counting = (async (url: unknown, init?: { body?: string }) => {
      requests += 1;
      return rpcFetch()(url as never, init as never);
    }) as unknown as typeof fetch;
    const heights = Array.from({ length: 25 }, (_, i) => 100 + i);
    const { blocks } = await fetchRawBlockChunk(
      "https://rpc",
      heights,
      counting,
    );
    assert.equal(blocks.length, 25);
    assert.equal(requests, 2, "one hash list, one batch of bodies and events");
    assert.deepEqual(
      blocks.map((b) => b.block_number),
      heights,
      "and in height order",
    );
  });

  test("correlates batch replies by id, not by position", async () => {
    // JSON-RPC lets a server return batch members in ANY order. Reading them
    // positionally assembles every block from another block's bytes -- capture
    // that is WRONG rather than missing, which no gap check would ever catch.
    const heights = [10, 11, 12];
    const { blocks } = await fetchRawBlockChunk(
      "https://rpc",
      heights,
      rpcFetch({ shuffle: true }),
    );
    assert.equal(blocks.length, 3);
    for (const block of blocks) {
      assert.equal(
        block.block_hash,
        `0xh${block.block_number}`,
        "each block carries its OWN hash",
      );
      assert.deepEqual(block.extrinsics, [
        `0xext${block.block_number}a`,
        `0xext${block.block_number}b`,
      ]);
      assert.equal(block.events, `0xev${block.block_number}`);
    }
  });

  test("records a pruned events blob as null, distinct from 'no events'", async () => {
    const { blocks } = await fetchRawBlockChunk(
      "https://rpc",
      [7],
      rpcFetch({ events: null }),
    );
    assert.equal(blocks[0]!.events, null);
  });

  test("keeps the prefix before a bad block and says where it stopped", async () => {
    for (const [opts, pattern] of [
      [{ badHashAt: 5 }, /no hash at height 5/],
      [{ badBlockAt: 5 }, /malformed block at height 5/],
      [{ badEventsAt: 5 }, /malformed events at height 5/],
      [{ failAt: 5 }, /state already discarded at 5/],
    ] as const) {
      const { blocks, stopped } = await fetchRawBlockChunk(
        "https://rpc",
        [3, 4, 5, 6],
        rpcFetch(opts),
      );
      assert.deepEqual(
        blocks.map((b) => b.block_number),
        [3, 4],
        `prefix kept for ${JSON.stringify(opts)}`,
      );
      assert.equal(stopped?.at, 5);
      assert.match(stopped?.reason ?? "", pattern);
    }
  });

  test("an events failure stops the chunk exactly like a body failure", async () => {
    // Both legs of the batch matter. A chunk that kept a block whose events
    // call failed would advance the watermark over bytes that are not there.
    const eventsBad = (async (_u: unknown, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? "{}");
      if (!Array.isArray(body)) {
        return {
          ok: true,
          json: async () => ({ result: ["0xh3", "0xh4", "0xh5"] }),
        } as unknown as Response;
      }
      return {
        ok: true,
        json: async () =>
          body.map((call: { id: number; method: string; params: unknown[] }) =>
            call.method === "state_getStorage" && call.params[1] === "0xh5"
              ? { id: call.id, error: { message: "events pruned at 5" } }
              : {
                  id: call.id,
                  result:
                    call.method === "chain_getBlock"
                      ? {
                          block: {
                            header: { parentHash: "0xp" },
                            extrinsics: [],
                          },
                        }
                      : "0xev",
                },
          ),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const { blocks, stopped } = await fetchRawBlockChunk(
      "https://rpc",
      [3, 4, 5],
      eventsBad,
    );
    assert.deepEqual(
      blocks.map((b) => b.block_number),
      [3, 4],
    );
    assert.equal(stopped?.at, 5);
    assert.match(stopped?.reason ?? "", /events pruned at 5/);
  });

  test("a null hash at the FIRST height captures nothing and says so", async () => {
    // The chain has not produced it yet. That BOUNDS the chunk rather than
    // failing it, and with nothing before it the chunk is empty -- which must
    // still carry a reason, or the lane declines without saying why.
    const { blocks, stopped } = await fetchRawBlockChunk(
      "https://rpc",
      [5, 6, 7],
      rpcFetch({ badHashAt: 5 }),
    );
    assert.deepEqual(blocks, []);
    assert.equal(stopped?.at, 5);
    assert.match(stopped?.reason ?? "", /no hash at height 5/);
  });

  test("a whole-request failure throws, so the caller can rotate", async () => {
    // Distinct from a per-call error: nothing was read, so there is no prefix
    // to keep and another endpoint may serve the same heights.
    await assert.rejects(
      fetchRawBlockChunk("https://rpc", [4, 5], rpcFetch({ httpFailAt: 5 })),
      /HTTP 500/,
    );
  });

  test("a non-array answer to a batch is a failure, not an empty read", async () => {
    // What the live node returns over its stated 50-call limit: HTTP 200
    // carrying a single error OBJECT. Read as "no results" it would look like
    // a clean chunk of nothing and advance nothing forever.
    const tooLarge = (async (_u: unknown, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? "{}");
      if (!Array.isArray(body)) {
        return {
          ok: true,
          json: async () => ({ result: ["0xh1", "0xh2"] }),
        } as unknown as Response;
      }
      return {
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          error: {
            code: -32010,
            message: "The batch request was too large",
            data: "Exceeded max limit of 50",
          },
          id: null,
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    await assert.rejects(
      fetchRawBlockChunk("https://rpc", [1, 2], tooLarge),
      /was not a JSON-RPC batch/,
    );
  });

  test("a bare value answering a list request is refused", async () => {
    // Reading one hash as the answer for many heights would give every block
    // in the chunk the same bytes.
    const bare = (async () =>
      ({
        ok: true,
        json: async () => ({ result: "0xh1" }),
      }) as unknown as Response) as unknown as typeof fetch;
    const { blocks, stopped } = await fetchRawBlockChunk(
      "https://rpc",
      [1, 2, 3],
      bare,
    );
    assert.deepEqual(blocks, []);
    assert.equal(stopped?.at, 1);
    assert.match(stopped?.reason ?? "", /expected a list of 3 hashes/);
  });

  test("a non-string extrinsic is refused, not coerced", async () => {
    const mixed = (async (_u: unknown, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? "{}");
      if (!Array.isArray(body)) {
        return {
          ok: true,
          json: async () => ({ result: ["0xh5"] }),
        } as unknown as Response;
      }
      return {
        ok: true,
        json: async () =>
          body.map((call: { id: number; method: string }) => ({
            id: call.id,
            result:
              call.method === "chain_getBlock"
                ? { block: { header: { parentHash: "0xp" }, extrinsics: [1] } }
                : "0xev5",
          })),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const { blocks, stopped } = await fetchRawBlockChunk(
      "https://rpc",
      [5],
      mixed,
    );
    assert.deepEqual(blocks, []);
    assert.match(stopped?.reason ?? "", /non-string extrinsic/);
  });

  test("a non-string parentHash degrades to empty rather than throwing", async () => {
    const noParent = (async (_u: unknown, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? "{}");
      if (!Array.isArray(body)) {
        return {
          ok: true,
          json: async () => ({ result: ["0xh5"] }),
        } as unknown as Response;
      }
      return {
        ok: true,
        json: async () =>
          body.map((call: { id: number; method: string }) => ({
            id: call.id,
            result:
              call.method === "chain_getBlock"
                ? { block: { header: {}, extrinsics: [] } }
                : "0xev5",
          })),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const { blocks } = await fetchRawBlockChunk("https://rpc", [5], noParent);
    assert.equal(
      blocks[0]!.parent_hash,
      "",
      "the block is still captured -- a missing parentHash must not cost us the bytes",
    );
  });

  test("no heights means no request at all", async () => {
    let requests = 0;
    const counting = (async () => {
      requests += 1;
      return { ok: false, status: 500 } as Response;
    }) as unknown as typeof fetch;
    const chunk = await fetchRawBlockChunk("https://rpc", [], counting);
    assert.deepEqual(chunk.blocks, []);
    assert.equal(chunk.stopped, null);
    assert.equal(requests, 0);
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
      rpcUrls: ["https://rpc"],
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
    await assert.rejects(
      fetchRawBlockChunk("https://rpc", [1], erroring),
      /boom/,
    );
  });
});

describe("captureTick — the no-gap guarantee", () => {
  test("first tick starts AT the floor, not after it", async () => {
    const { store, puts } = memoryStore();
    const { watermark, get } = memoryWatermark(null);
    const result = await captureTick({
      rpcUrls: ["https://rpc"],
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
      rpcUrls: ["https://rpc"],
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
      rpcUrls: ["https://rpc"],
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
      rpcUrls: ["https://rpc"],
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
      rpcUrls: ["https://rpc"],
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
      rpcUrls: ["https://rpc"],
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
      rpcUrls: ["https://rpc"],
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
        rpcUrls: ["https://rpc"],
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
        rpcUrls: ["https://rpc"],
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
        rpcUrls: ["https://rpc.invalid"],
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

  test("pacing waits between chunks, never before the first", async () => {
    const { gaps, deps } = chunkedDeps({
      heights: 4,
      flushEvery: 1,
      minGapMs: 4500,
    });
    const result = await captureTick(deps as never);
    assert.equal(result.captured, 4);
    assert.deepEqual(gaps, [4500, 4500, 4500]);
  });

  test("the gap is a CYCLE time, so a slow read does not add to it", async () => {
    // A flat sleep after the work makes the real period `gap + latency`, and a
    // chunk is ~1.7 s of transfer against the live archive -- so a tick paced
    // that way overruns its cron interval and gets killed, which is the exact
    // failure the chunking exists to end. Pacing from the START of the previous
    // read keeps the REQUEST RATE on budget whatever the latency costs.
    const gaps: number[] = [];
    const { store } = memoryStore();
    const { watermark } = memoryWatermark(99);
    let clock = 0;
    const result = await captureTick({
      rpcUrls: ["https://rpc"],
      store,
      watermark,
      genesisFloor: 100,
      maxPerTick: 3,
      flushEvery: 1,
      minGapMs: 1000,
      // Each read costs 400ms of the 1000ms cycle.
      now: () => (clock += 400),
      fetchImpl: rpcFetch({ head: 103 }),
      sleepFn: async (ms) => {
        gaps.push(ms);
      },
    });
    assert.equal(result.captured, 3);
    assert.ok(
      gaps.every((ms) => ms < 1000),
      `the read's own duration must come off the gap, got ${JSON.stringify(gaps)}`,
    );
  });

  test("a read slower than its gap waits not at all, rather than negatively", async () => {
    // The other side of cycle pacing. Once a chunk takes longer than the
    // budgeted period the lane is already at or under its request rate, so
    // there is nothing left to wait for -- and sleeping a negative number, or
    // the full gap on top, is how a tick overruns its interval.
    const gaps: number[] = [];
    const { store } = memoryStore();
    const { watermark } = memoryWatermark(99);
    let clock = 0;
    const result = await captureTick({
      rpcUrls: ["https://rpc"],
      store,
      watermark,
      genesisFloor: 100,
      maxPerTick: 3,
      flushEvery: 1,
      minGapMs: 10,
      // Every clock read jumps well past the 10ms gap.
      now: () => (clock += 5_000),
      fetchImpl: rpcFetch({ head: 103 }),
      sleepFn: async (ms) => {
        gaps.push(ms);
      },
    });
    assert.equal(result.captured, 3);
    assert.deepEqual(gaps, [], "no sleep at all once the read outran the gap");
  });

  test("the default sleep is a real timer, not a no-op", async () => {
    // Every other test injects one, so without this the shipped pacing would be
    // exercised by nothing. Milliseconds: this is about the wiring.
    const { deps } = chunkedDeps({ heights: 3, flushEvery: 1, minGapMs: 20 });
    const { sleepFn: _injected, ...shipped } = deps as Record<string, unknown>;
    const started = Date.now();
    const result = await captureTick(shipped as never);
    assert.equal(result.captured, 3);
    // Two gaps between three chunks, so at least ~40ms of real waiting.
    assert.ok(
      Date.now() - started >= 30,
      "the shipped pacing did not actually wait",
    );
  });
});

/**
 * Reading from MORE THAN ONE archive host.
 *
 * NOT FOR RATE. The lane fell 8,409 blocks (~28 h) behind on 2026-08-16, and
 * rotation was not what bought it out -- batching was. The allowance is per
 * BACKEND NODE (re-measured 2026-08-16: exhausting archive.chain.opentensor.ai
 * then draining lite.chain.opentensor.ai got a full fresh 100), but two of the
 * three mainnet names resolve to the same machine, and one node's allowance
 * already funds hundreds of blocks/minute against a chain producing five. So
 * the list buys FAILOVER and archive-depth coverage. The no-gap guarantee is
 * the thing that must survive it, so these are mostly about that.
 */
describe("captureTick — reading across several endpoints", () => {
  /**
   * Records which heights each host was asked for.
   *
   * `failOn` is a per-CALL error, which is how a node actually refuses a height
   * it cannot serve -- the chunk then keeps its prefix, which is the behaviour
   * these tests are about.
   */
  function trackingFetch(
    opts: {
      head?: number;
      failOn?: (url: string, height: number) => boolean;
    } = {},
  ) {
    const byHost: Record<string, number[]> = {};
    const heightOf = (hash: string) => Number(hash.replace("0xh", ""));
    const impl = (async (url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? "{}") as
        | { method: string; params: unknown[] }
        | { id: number; method: string; params: unknown[] }[];
      const host = String(url);
      const answer = (method: string, params: unknown[]) => {
        if (method === "chain_getHeader") {
          return { result: { number: `0x${(opts.head ?? 110).toString(16)}` } };
        }
        if (method === "chain_getBlockHash") {
          const first = params[0];
          const wanted = (Array.isArray(first) ? first : [first]) as number[];
          (byHost[host] ||= []).push(...wanted);
          const hashes = wanted.map((n) => `0xh${n}`);
          return { result: Array.isArray(first) ? hashes : hashes[0] };
        }
        if (method === "chain_getBlock") {
          const n = heightOf(params[0] as string);
          if (opts.failOn?.(host, n)) {
            return { error: { message: `cannot serve ${n} from ${host}` } };
          }
          return {
            result: {
              block: {
                header: { number: "0x1", parentHash: "0xp" },
                extrinsics: ["0xaa"],
              },
            },
          };
        }
        return { result: "0xevents" };
      };
      if (!Array.isArray(body)) {
        return {
          ok: true,
          json: async () => answer(body.method, body.params),
        } as unknown as Response;
      }
      return {
        ok: true,
        json: async () =>
          body.map((call) => ({
            id: call.id,
            ...answer(call.method, call.params),
          })),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    return { impl, byHost };
  }

  test("consecutive CHUNKS land on different hosts", async () => {
    // Rotation is per chunk now, because a chunk is the unit of a read.
    const { store } = memoryStore();
    const { watermark } = memoryWatermark(99);
    const { impl, byHost } = trackingFetch();
    const result = await captureTick({
      rpcUrls: ["https://a", "https://b"],
      store,
      watermark,
      genesisFloor: 0,
      maxPerTick: 4,
      flushEvery: 2,
      fetchImpl: impl,
    });
    assert.equal(result.captured, 4);
    assert.deepEqual(byHost["https://a"], [100, 101]);
    assert.deepEqual(byHost["https://b"], [102, 103]);
  });

  test("a height one host cannot serve is retried on another, NOT skipped", async () => {
    // A flaky host must degrade throughput, never pin the watermark -- and it
    // must never leave a hole, which is the one thing this module exists for.
    // The failing height leads the chunk, so the read returns NOTHING from the
    // first host, which is exactly the condition that rotates.
    const { store } = memoryStore();
    const { watermark, get } = memoryWatermark(99);
    const { impl } = trackingFetch({
      failOn: (url, height) => url === "https://a" && height === 100,
    });
    const result = await captureTick({
      rpcUrls: ["https://a", "https://b"],
      store,
      watermark,
      genesisFloor: 0,
      maxPerTick: 3,
      fetchImpl: impl,
    });
    assert.equal(result.captured, 3, "100 came from the second host");
    assert.equal(result.stoppedAt, undefined);
    assert.equal(get(), 102);
  });

  test("a height NO host can serve still stops the tick and keeps the prefix", async () => {
    const { store } = memoryStore();
    const { watermark, get } = memoryWatermark(99);
    const { impl } = trackingFetch({
      failOn: (_url, height) => height === 102,
    });
    const result = await captureTick({
      rpcUrls: ["https://a", "https://b"],
      store,
      watermark,
      genesisFloor: 0,
      maxPerTick: 6,
      fetchImpl: impl,
    });
    assert.equal(result.captured, 2, "100 and 101 only");
    assert.equal(result.stoppedAt, 102);
    assert.equal(
      get(),
      101,
      "one BELOW the failure, so the next tick retries it",
    );
  });

  test("the head is read from whichever host answers, not a fixed one", async () => {
    // A tick must not be lost because the preferred host is down when another
    // could have served the whole run.
    const { store } = memoryStore();
    const { watermark } = memoryWatermark(99);
    const inner = trackingFetch();
    const firstHostDead = (async (url: unknown, init?: { body?: string }) => {
      if (String(url) === "https://dead") throw new Error("dead host");
      return inner.impl(url as string, init as RequestInit);
    }) as unknown as typeof fetch;
    const result = await captureTick({
      rpcUrls: ["https://dead", "https://b"],
      store,
      watermark,
      genesisFloor: 0,
      maxPerTick: 2,
      fetchImpl: firstHostDead,
    });
    assert.equal(result.captured, 2);
  });

  test("the per-chunk gap does NOT shrink as endpoints are added", async () => {
    // The premise correction, twice over. Dividing the gap by the rotation
    // width assumes each name is its own allowance; DNS says otherwise --
    // entrypoint-finney.opentensor.ai is a CNAME to lite.chain.opentensor.ai,
    // one machine under two names, and draining the second after the first got
    // 0 requests. A divisor would spend one node's minute in a fraction of it
    // and buy a 429 partway through the tick. Batching made the question moot:
    // there is no throughput left to want. The rotation is failover, not rate.
    const slept: number[] = [];
    const { store } = memoryStore();
    const { watermark } = memoryWatermark(99);
    const { impl } = trackingFetch();
    await captureTick({
      rpcUrls: ["https://a", "https://b", "https://c"],
      store,
      watermark,
      genesisFloor: 0,
      maxPerTick: 3,
      flushEvery: 1,
      minGapMs: 900,
      fetchImpl: impl,
      // Pinned so the gap is the whole assertion: captureTick paces on the
      // CYCLE, subtracting a read's own duration, so a moving clock would make
      // the expected numbers depend on how fast the fake fetch resolved.
      now: () => 1000,
      sleepFn: async (ms) => {
        slept.push(ms);
      },
    });
    assert.deepEqual(
      slept,
      [900, 900],
      "the caller's gap, unscaled, and never before the first chunk",
    );
  });

  test("an empty endpoint list is refused rather than read as 'no work'", async () => {
    const { store } = memoryStore();
    const { watermark } = memoryWatermark(99);
    await assert.rejects(
      captureTick({
        rpcUrls: [],
        store,
        watermark,
        genesisFloor: 0,
        maxPerTick: 1,
        fetchImpl: trackingFetch().impl,
      }),
      /rpcUrls is empty/,
    );
  });
});
