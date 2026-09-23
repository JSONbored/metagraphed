import assert from "node:assert/strict";
import { beforeEach, afterEach, test, vi } from "vitest";
const readers = vi.hoisted(() => ({
  block: vi.fn(),
  hash: vi.fn(),
  loadBlock: vi.fn(),
  loadHash: vi.fn(),
  absent: vi.fn(),
}));
vi.mock("../src/history-hash-hot-bridge.ts", () => ({
  historyHashAbsentFromHotBridge: readers.absent,
}));
vi.mock("../src/history-generation.ts", () => ({
  readHistoryBlock: readers.block,
  readHistoryHash: readers.hash,
  loadHistoryBlockGeneration: readers.loadBlock,
  loadHistoryGeneration: readers.loadHash,
}));
import {
  readSelectedHistoryBlock,
  readSelectedHistoryHash,
} from "../src/indexed-history-store.ts";
import { resetModuleState } from "../src/module-state-registry.ts";
import { parquetReadBudget } from "../src/indexed-parquet.ts";
import { currentIndexedHistoryFailureGeneration } from "../src/indexed-history-status.ts";
import {
  loadBlockChainEventsColdTier,
  loadBlockEventsColdTier,
} from "../src/events-cold-tier.ts";
import {
  loadBlockExtrinsicsColdTier,
  loadExtrinsicColdTier,
} from "../src/extrinsics-cold-tier.ts";
import { loadBlockFromR2Sql } from "../src/r2-sql-blocks.ts";
beforeEach(() => {
  resetModuleState();
  readers.block.mockReset().mockResolvedValue([]);
  readers.hash.mockReset().mockResolvedValue(null);
  readers.loadBlock.mockReset().mockResolvedValue({});
  readers.loadHash.mockReset().mockResolvedValue({});
  readers.absent.mockReset().mockResolvedValue(false);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const generation = "a".repeat(64);
const object = (key: string) => ({ key, etag: "etag", bytes: 1 });
function fixture(table = "chain_events", network = "mainnet") {
  const root = `metagraph/indexed-history/v1/${network}/${table}/generations/${generation}`;
  const selected = {
    version: 1,
    network,
    table,
    generation,
    firstBlock: 1,
    lastBlock: 10,
    blockManifest: object(root + "/block-manifest.json"),
    hashManifest: object(root + "/manifest.json"),
  };
  const get = vi
    .fn()
    .mockResolvedValue({ size: 100, json: async () => selected });
  return {
    selected,
    get,
    env: { METAGRAPH_ARCHIVE: { get }, R2_SQL_TOKEN: "test" },
  };
}
function segmentedFixture(table = "blocks", network = "mainnet") {
  const { selected: base, get, env } = fixture(table, network);
  const { version: _version, ...first } = base;
  const nextGeneration = "b".repeat(64);
  const root = `metagraph/indexed-history/v1/${network}/${table}/generations/${nextGeneration}`;
  const second = {
    ...first,
    generation: nextGeneration,
    firstBlock: 11,
    lastBlock: 20,
    blockManifest: object(root + "/block-manifest.json"),
    hashManifest: object(root + "/manifest.json"),
  };
  const selected = { version: 2, network, table, segments: [first, second] };
  get.mockResolvedValue({ size: 1000, json: async () => selected });
  return { selected, get, env };
}
test("qualified absence requires all historical hashes and preserves empty detail payloads without SQL", async () => {
  const hash = `0x${"ab".repeat(32)}`;
  const f = segmentedFixture();
  f.selected.segments[0].firstBlock = 0;
  readers.absent.mockResolvedValue(true);
  const fetcher = vi.fn().mockRejectedValue(new Error("SQL must not run"));
  vi.stubGlobal("fetch", fetcher);
  assert.deepEqual(await readSelectedHistoryHash(f.env, "blocks", hash), []);
  assert.deepEqual(readers.absent.mock.lastCall, [
    f.env,
    "blocks",
    hash,
    20,
    "mainnet",
  ]);
  assert.equal((await loadBlockFromR2Sql(f.env, hash))?.block, null);
  const extrinsics = await loadBlockExtrinsicsColdTier(f.env, hash, {
    limit: 20,
  });
  assert.equal(extrinsics, null);
  const events = await loadBlockEventsColdTier(f.env, hash, { limit: 20 });
  assert.equal(events, null);
  const x = fixture("extrinsics");
  x.selected.firstBlock = 0;
  assert.equal((await loadExtrinsicColdTier(x.env, hash))?.extrinsic, null);
  assert.equal(fetcher.mock.calls.length, 0);
  readers.absent.mockResolvedValue(false);
  assert.equal(await readSelectedHistoryHash(f.env, "blocks", hash), undefined);
  readers.absent.mockClear().mockResolvedValue(true);
  delete (f.selected.segments[1] as { hashManifest?: unknown }).hashManifest;
  resetModuleState();
  assert.equal(await readSelectedHistoryHash(f.env, "blocks", hash), undefined);
  assert.equal(readers.absent.mock.calls.length, 0);
  const corrupt = fixture("blocks");
  corrupt.selected.firstBlock = 0;
  readers.absent.mockRejectedValue(new Error("hot store unavailable"));
  assert.equal(
    await readSelectedHistoryHash(corrupt.env, "blocks", hash),
    null,
  );
  assert.equal(currentIndexedHistoryFailureGeneration(), 1);
});
test("segmented block reads select exactly one contiguous range and share the pointer cache", async () => {
  const { selected, env, get } = segmentedFixture("chain_events", "testnet");
  const budget = parquetReadBudget();
  for (const block of [1, 10, 11, 20]) {
    readers.block.mockResolvedValue([{ block_number: BigInt(block) }]);
    assert.deepEqual(
      await readSelectedHistoryBlock(
        env,
        "chain_events",
        block,
        "testnet",
        budget,
      ),
      [{ block_number: block }],
    );
    const segment = selected.segments[block > 10 ? 1 : 0];
    assert.deepEqual(
      readers.loadBlock.mock.lastCall?.[1],
      segment.blockManifest,
    );
    assert.equal(readers.loadBlock.mock.lastCall?.[3], budget);
    assert.equal(readers.block.mock.lastCall?.[4], budget);
  }
  for (const block of [0, 21])
    assert.equal(
      await readSelectedHistoryBlock(
        env,
        "chain_events",
        block,
        "testnet",
        budget,
      ),
      undefined,
    );
  assert.equal(readers.block.mock.calls.length, 4);
  assert.equal(get.mock.calls.length, 1);
});
test("segmented selections reject gaps, overlaps, duplicate generations and foreign scopes", async () => {
  const mutations = [
    (s: ReturnType<typeof segmentedFixture>["selected"]) => {
      s.segments = [];
    },
    (s: ReturnType<typeof segmentedFixture>["selected"]) => {
      s.segments = Array(5).fill(s.segments[0]);
    },
    (s: ReturnType<typeof segmentedFixture>["selected"]) => {
      s.network = "testnet";
    },
    (s: ReturnType<typeof segmentedFixture>["selected"]) => {
      s.table = "extrinsics";
    },
    (s: ReturnType<typeof segmentedFixture>["selected"]) => {
      s.segments[1].network = "testnet";
    },
    (s: ReturnType<typeof segmentedFixture>["selected"]) => {
      s.segments[1].table = "extrinsics";
    },
    (s: ReturnType<typeof segmentedFixture>["selected"]) => {
      s.segments[1].firstBlock = 12;
    },
    (s: ReturnType<typeof segmentedFixture>["selected"]) => {
      s.segments[1].firstBlock = 10;
    },
    (s: ReturnType<typeof segmentedFixture>["selected"]) => {
      s.segments.reverse();
    },
    (s: ReturnType<typeof segmentedFixture>["selected"]) => {
      s.segments[1].lastBlock = 9;
    },
    (s: ReturnType<typeof segmentedFixture>["selected"]) => {
      s.segments[1].generation = s.segments[0].generation;
    },
    (s: ReturnType<typeof segmentedFixture>["selected"]) => {
      s.segments[1].blockManifest = object("foreign");
    },
    (s: ReturnType<typeof segmentedFixture>["selected"]) => {
      s.segments[1].hashManifest = object("foreign");
    },
  ];
  for (const mutate of mutations) {
    const { env, selected } = segmentedFixture();
    mutate(selected);
    assert.equal(await readSelectedHistoryBlock(env, "blocks", 7), null);
    assert.equal(await readSelectedHistoryHash(env, "blocks", "hash"), null);
  }
  assert.equal(readers.loadBlock.mock.calls.length, 0);
  assert.equal(readers.loadHash.mock.calls.length, 0);
});
test("segmented hash lookup searches newest first with one operation budget", async () => {
  const { env, selected } = segmentedFixture();
  const budget = parquetReadBudget();
  readers.hash.mockResolvedValueOnce({ block_number: 12n });
  assert.deepEqual(
    await readSelectedHistoryHash(env, "blocks", "hash", "mainnet", budget),
    { block_number: 12 },
  );
  assert.equal(readers.hash.mock.calls.length, 1);
  assert.deepEqual(
    readers.loadHash.mock.lastCall?.[1],
    selected.segments[1].hashManifest,
  );
  for (const miss of [null, { block_number: 10n }, { block_number: 21n }]) {
    readers.hash
      .mockClear()
      .mockResolvedValueOnce(miss)
      .mockResolvedValueOnce({ block_number: 3n });
    readers.loadHash.mockClear();
    assert.deepEqual(
      await readSelectedHistoryHash(env, "blocks", "hash", "mainnet", budget),
      { block_number: 3 },
    );
    assert.deepEqual(
      readers.loadHash.mock.calls.map((call) => call[1]),
      selected.segments.toReversed().map((s) => s.hashManifest),
    );
    for (const call of readers.loadHash.mock.calls)
      assert.equal(call[3], budget);
    for (const call of readers.hash.mock.calls) assert.equal(call[4], budget);
    assert.equal(readers.hash.mock.calls[0][0], readers.hash.mock.calls[1][0]);
  }
  readers.hash.mockClear().mockResolvedValue(null);
  assert.equal(await readSelectedHistoryHash(env, "blocks", "hash"), undefined);
  assert.equal(readers.hash.mock.calls.length, 2);
  delete (selected.segments[1] as { hashManifest?: unknown }).hashManifest;
  // Parsed pointer caches are immutable snapshots of the JSON payload.
  resetModuleState();
  readers.hash.mockClear().mockResolvedValue({ block_number: 3n });
  assert.deepEqual(await readSelectedHistoryHash(env, "blocks", "hash"), {
    block_number: 3,
  });
  assert.equal(readers.hash.mock.calls.length, 1);
  readers.hash.mockClear().mockRejectedValue(new Error("R2 failed"));
  assert.equal(await readSelectedHistoryHash(env, "blocks", "hash"), null);
  assert.equal(readers.hash.mock.calls.length, 1);
});
test("hash rows with invalid block identities fail rather than coercing into a covered range", async () => {
  const { env } = segmentedFixture();
  for (const block_number of [
    null,
    undefined,
    "12",
    12.5,
    NaN,
    Infinity,
    9007199254740992,
    9007199254740993n,
  ]) {
    readers.hash.mockClear().mockResolvedValue({ block_number });
    assert.equal(await readSelectedHistoryHash(env, "blocks", "hash"), null);
    assert.equal(readers.hash.mock.calls.length, 1);
  }
});
test("selected block reads cache the pointer, enforce coverage, and preserve numeric values", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const { env, get, selected } = fixture();
  readers.block.mockResolvedValue([
    {
      block_number: 7n,
      observed_at: 10n,
      wide: 9007199254740993n,
      negative: -9007199254740993n,
      args: "opaque",
    },
  ]);
  const expected = [
    {
      block_number: 7,
      observed_at: 10,
      wide: "9007199254740993",
      negative: "-9007199254740993",
      args: "opaque",
    },
  ];
  assert.deepEqual(
    await readSelectedHistoryBlock(env, "chain_events", 7),
    expected,
  );
  assert.deepEqual(
    await readSelectedHistoryBlock(env, "chain_events", 8),
    expected,
  );
  assert.equal(get.mock.calls.length, 1);
  assert.equal(
    await readSelectedHistoryBlock(env, "chain_events", 0),
    undefined,
  );
  assert.equal(
    await readSelectedHistoryBlock(env, "chain_events", 11),
    undefined,
  );
  vi.setSystemTime(61001);
  await readSelectedHistoryBlock(env, "chain_events", 7);
  assert.equal(get.mock.calls.length, 2);
  assert.deepEqual(readers.loadBlock.mock.calls[0][1], selected.blockManifest);
  assert.equal(
    await readSelectedHistoryBlock(null, "chain_events", 7),
    undefined,
  );
  const missing = fixture();
  missing.get.mockResolvedValue(null);
  assert.equal(
    await readSelectedHistoryBlock(missing.env, "chain_events", 7),
    undefined,
  );
  assert.equal(currentIndexedHistoryFailureGeneration(), 0);
});
test("unreadable, invalid and mismatched selected generations fail without a legacy fallback", async () => {
  for (const change of [
    { network: "testnet" },
    { table: "blocks" },
    { firstBlock: 11 },
    { generation: "b".repeat(64) },
    { hashManifest: object("foreign") },
    { blockManifest: object("foreign") },
  ]) {
    const { env, selected } = fixture();
    Object.assign(selected, change);
    assert.equal(await readSelectedHistoryBlock(env, "chain_events", 7), null);
  }
  const tooBig = fixture();
  tooBig.get.mockResolvedValue({ size: 16385 });
  assert.equal(
    await readSelectedHistoryBlock(tooBig.env, "chain_events", 7),
    null,
  );
  const failed = fixture();
  failed.get.mockRejectedValue(new Error("R2 unavailable"));
  assert.equal(
    await readSelectedHistoryBlock(failed.env, "chain_events", 7),
    null,
  );
  const corrupt = fixture();
  readers.loadBlock.mockRejectedValue(new Error("incomplete"));
  assert.equal(
    await readSelectedHistoryBlock(corrupt.env, "chain_events", 7),
    null,
  );
});
test("hash lookups distinguish a base miss and uncovered rows from an index failure", async () => {
  const { env } = fixture("blocks");
  assert.equal(
    await readSelectedHistoryHash(undefined, "blocks", "hash"),
    undefined,
  );
  const absent = fixture("blocks");
  absent.get.mockResolvedValue(null);
  assert.equal(
    await readSelectedHistoryHash(absent.env, "blocks", "hash"),
    undefined,
  );
  const noHash = fixture("blocks");
  delete (noHash.selected as { hashManifest?: unknown }).hashManifest;
  assert.equal(
    await readSelectedHistoryHash(noHash.env, "blocks", "hash"),
    undefined,
  );
  assert.equal(await readSelectedHistoryHash(env, "blocks", "hash"), undefined);
  readers.hash.mockResolvedValue({ block_number: 7n, wide: 9007199254740993n });
  assert.deepEqual(await readSelectedHistoryHash(env, "blocks", "hash"), {
    block_number: 7,
    wide: "9007199254740993",
  });
  for (const block of [0n, 11n]) {
    readers.hash.mockResolvedValue({ block_number: block });
    assert.equal(
      await readSelectedHistoryHash(env, "blocks", "hash"),
      undefined,
    );
  }
  assert.equal(currentIndexedHistoryFailureGeneration(), 0);
  readers.hash.mockRejectedValue(new Error("bad pointer"));
  assert.equal(await readSelectedHistoryHash(env, "blocks", "hash"), null);
  const testnet = fixture("extrinsics", "testnet");
  assert.equal(
    await readSelectedHistoryHash(testnet.env, "extrinsics", "hash", "testnet"),
    null,
  );
  assert.equal(
    testnet.get.mock.calls[0][0],
    "metagraph/indexed-history/v1/testnet/extrinsics/current.json",
  );
});
test("the chain-events route keeps payload parity and makes no SQL request for selected blocks", async () => {
  const { env } = fixture();
  const fetch = vi.fn(() => {
    throw new Error("SQL must not execute");
  });
  vi.stubGlobal("fetch", fetch);
  const row = {
    block_number: 7n,
    event_index: 2n,
    pallet: "System",
    method: "ExtrinsicSuccess",
    args: "{}",
    phase: "ApplyExtrinsic",
    extrinsic_index: 0n,
    observed_at: 10n,
  };
  readers.block.mockResolvedValue([row, { ...row, event_index: 1n }]);
  const result = await loadBlockChainEventsColdTier(env, "7");
  assert.ok(result);
  assert.equal(result?.count, 2);
  assert.deepEqual(
    result.events.map((event) => event.event_index),
    [1, 2],
  );
  assert.equal(fetch.mock.calls.length, 0);
  readers.block.mockRejectedValue(new Error("missing artifact"));
  assert.equal(await loadBlockChainEventsColdTier(env, "7"), null);
  assert.equal(fetch.mock.calls.length, 0);
  readers.block.mockResolvedValue([{ ...row, event_index: "bad" }]);
  assert.equal(await loadBlockChainEventsColdTier(env, "7"), null);
  const hashes = fixture("blocks");
  readers.hash.mockResolvedValue({ block_number: 7n });
  const get = vi.fn(async (key: string) =>
    key.includes("/blocks/")
      ? { size: 100, json: async () => hashes.selected }
      : { size: 100, json: async () => fixture().selected },
  );
  readers.block.mockResolvedValue([row]);
  const both = { ...env, METAGRAPH_ARCHIVE: { get } };
  assert.equal(
    (await loadBlockChainEventsColdTier(both, "0x" + "a".repeat(64)))?.count,
    1,
  );
  readers.hash.mockRejectedValue(new Error("hash failure"));
  assert.equal(
    await loadBlockChainEventsColdTier(both, "0x" + "b".repeat(64)),
    null,
  );
  assert.equal(fetch.mock.calls.length, 0);
});
