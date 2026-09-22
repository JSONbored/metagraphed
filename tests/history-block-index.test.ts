import assert from "node:assert/strict";
import { beforeAll, afterAll, test } from "vitest";
import { Miniflare } from "miniflare";
import {
  findHistoryBlockRuns,
  validateHistoryBlockIndex,
} from "../src/history-block-index.ts";
import { parquetReadBudget, r2ParquetSource } from "../src/indexed-parquet.ts";
import type { HistoryBlockIndex } from "../schemas-src/artifacts/history-block-index.ts";
const runtime = new Miniflare({
  modules: true,
  script: "export default {fetch(){return new Response('test')}}",
  compatibilityDate: "2026-06-06",
  r2Buckets: ["ARCHIVE"],
});
let bucket: R2Bucket;
beforeAll(async () => {
  bucket = (await runtime.getR2Bucket("ARCHIVE")) as unknown as R2Bucket;
});
afterAll(async () => runtime.dispose());
const generation = "b".repeat(64);
const base = {
  generation,
  network: "mainnet" as const,
  table: "extrinsics" as const,
};
async function fixture(runs = 200000, same = false, count = 2) {
  const bytes = new Uint8Array(runs * 24);
  for (let run = 0; run < runs; run++) {
    const view = new DataView(bytes.buffer, run * 24, 24);
    view.setUint32(0, 65536 + (same ? 0 : Math.floor(run / 4) * 1), true);
    view.setUint32(4, 0, true);
    view.setUint32(8, run * count, true);
    view.setUint32(12, count, true);
    view.setBigUint64(16, 1790000000000n + BigInt(run), true);
  }
  const key = `metagraph/indexed-history/v1/mainnet/extrinsics/generations/${generation}/blocks/0001.bin`;
  const object = await bucket.put(key, bytes);
  assert.ok(object);
  const scope = { ...base, fileRows: runs ? [runs * count] : [] };
  const index: HistoryBlockIndex = {
    version: 1,
    ...base,
    state: "complete",
    rows: runs * count,
    runs,
    shards: runs
      ? [
          {
            version: 1,
            ...base,
            prefix: "0001",
            key,
            etag: object.etag,
            bytes: bytes.length,
            rows: runs * count,
            runs,
            firstBlock: 65536,
            lastBlock: 65536 + (same ? 0 : Math.floor((runs - 1) / 4)),
          },
        ]
      : [],
  };
  return { index, scope, bytes, key };
}
test("complete block lookups retain every physical capture through bounded conditional reads", async () => {
  const { index, scope } = await fixture();
  for (const block of [65536, 65791, 65792, 90536, 115535]) {
    const budget = parquetReadBudget();
    const first = (block - 65536) * 4;
    const rows = await findHistoryBlockRuns(
      r2ParquetSource(bucket),
      index,
      scope,
      block,
      budget,
    );
    assert.deepEqual(
      rows,
      Array.from({ length: 4 }, (_, i) => ({
        fileId: 0,
        rowStart: (first + i) * 2,
        rows: 2,
        observedAt: 1790000000000 + first + i,
      })),
    );
    assert.ok(budget.requests <= 9);
    assert.ok(budget.bytes <= 9 * 24576);
  }
  for (const block of [0, 65535, 115536, 131072, 0xffffffff]) {
    const budget = parquetReadBudget();
    assert.deepEqual(
      await findHistoryBlockRuns(
        r2ParquetSource(bucket),
        index,
        scope,
        block,
        budget,
      ),
      [],
    );
    assert.equal(budget.requests, 0);
  }
  const holes = await fixture(8);
  const view = new DataView(holes.bytes.buffer);
  for (let i = 4; i < 8; i++) view.setUint32(i * 24, 65538, true);
  const changed = await bucket.put(holes.key, holes.bytes);
  assert.ok(changed);
  holes.index.shards[0].etag = changed.etag;
  holes.index.shards[0].lastBlock = 65539;
  for (const block of [65537, 65539])
    assert.deepEqual(
      await findHistoryBlockRuns(
        r2ParquetSource(bucket),
        holes.index,
        holes.scope,
        block,
        parquetReadBudget(),
      ),
      [],
    );
  const empty = await fixture(0);
  assert.deepEqual(
    await findHistoryBlockRuns(
      r2ParquetSource(bucket),
      empty.index,
      empty.scope,
      1,
      parquetReadBudget(),
    ),
    [],
  );
});
test("an incomplete or cross-generation index cannot establish absence", async () => {
  const { index, scope } = await fixture(8);
  for (const change of [
    { generation: "c".repeat(64) },
    { network: "testnet" },
    { table: "blocks" },
  ])
    assert.throws(
      () => validateHistoryBlockIndex({ ...index, ...change }, scope),
      /scope mismatch/,
    );
  for (const fileRows of [[NaN], [0], [0x100000000], [-1]])
    assert.throws(
      () => validateHistoryBlockIndex(index, { ...scope, fileRows }),
      /row count invalid/,
    );
  for (const change of [{ rows: 1 }, { runs: 1 }, { shards: [] }])
    assert.throws(
      () => validateHistoryBlockIndex({ ...index, ...change }, scope),
      /incomplete/,
    );
  for (const change of [
    { generation: "c".repeat(64) },
    { network: "testnet" },
    { table: "blocks" },
    { key: "foreign" },
    { bytes: 1 },
    { rows: 1 },
    { firstBlock: 65539 },
    { firstBlock: 1 },
    { lastBlock: 131072 },
  ]) {
    assert.throws(
      () =>
        validateHistoryBlockIndex(
          { ...index, shards: [{ ...index.shards[0], ...change }] },
          scope,
        ),
      /scope or census mismatch/,
    );
  }
  assert.throws(
    () =>
      validateHistoryBlockIndex(
        { ...index, shards: [index.shards[0], index.shards[0]] },
        scope,
      ),
    /scope or census mismatch/,
  );
  for (const block of [-1, 1.5, NaN, Infinity, 0x100000000])
    await assert.rejects(
      findHistoryBlockRuns(
        r2ParquetSource(bucket),
        index,
        scope,
        block,
        parquetReadBudget(),
      ),
      /Invalid history block/,
    );
});
test("foreign keys, invalid physical pointers and excessive results fail without a prefix", async () => {
  for (const mutate of [
    (v: DataView) => v.setUint32(0, 1, true),
    (v: DataView) => v.setUint32(0, 65539, true),
    (v: DataView) => v.setUint32(4, 1, true),
    (v: DataView) => v.setUint32(8, 20, true),
    (v: DataView) => v.setUint32(12, 0, true),
    (v: DataView) =>
      v.setBigUint64(16, BigInt(Number.MAX_SAFE_INTEGER) + 1n, true),
  ]) {
    const { index, scope, bytes, key } = await fixture(1);
    mutate(new DataView(bytes.buffer));
    const changed = await bucket.put(key, bytes);
    assert.ok(changed);
    index.shards[0].etag = changed.etag;
    await assert.rejects(
      findHistoryBlockRuns(
        r2ParquetSource(bucket),
        index,
        scope,
        65536,
        parquetReadBudget(),
      ),
      /foreign block|outside its generation/,
    );
  }
  for (const [runs, count] of [
    [4097, 1],
    [1, 65537],
  ]) {
    const { index, scope } = await fixture(runs, true, count);
    await assert.rejects(
      findHistoryBlockRuns(
        r2ParquetSource(bucket),
        index,
        scope,
        65536,
        parquetReadBudget(),
      ),
      /result budget/,
    );
  }
  const { index, scope, key } = await fixture(8);
  await assert.rejects(
    findHistoryBlockRuns(
      r2ParquetSource(bucket),
      index,
      scope,
      65536,
      parquetReadBudget(1),
    ),
    /budget/,
  );
  await bucket.put(key, "replacement");
  await assert.rejects(
    findHistoryBlockRuns(
      r2ParquetSource(bucket),
      index,
      scope,
      65536,
      parquetReadBudget(),
    ),
    /missing or changed/,
  );
  await bucket.delete(key);
  await assert.rejects(
    findHistoryBlockRuns(
      r2ParquetSource(bucket),
      index,
      scope,
      65536,
      parquetReadBudget(),
    ),
    /missing or changed/,
  );
});
