import assert from "node:assert/strict";
import { beforeEach, afterEach, test, vi } from "vitest";
const readers = vi.hoisted(() => ({
  block: vi.fn(),
  hash: vi.fn(),
  loadBlock: vi.fn(),
  loadHash: vi.fn(),
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
import { loadBlockChainEventsColdTier } from "../src/events-cold-tier.ts";
beforeEach(() => {
  resetModuleState();
  readers.block.mockReset().mockResolvedValue([]);
  readers.hash.mockReset().mockResolvedValue(null);
  readers.loadBlock.mockReset().mockResolvedValue({});
  readers.loadHash.mockReset().mockResolvedValue({});
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
