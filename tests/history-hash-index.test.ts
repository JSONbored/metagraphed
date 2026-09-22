import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "vitest";
import { Miniflare } from "miniflare";
import { findHistoryHash } from "../src/history-hash-index.ts";
import { parquetReadBudget, r2ParquetSource } from "../src/indexed-parquet.ts";
import type { HistoryHashShard } from "../schemas-src/artifacts/history-hash-index.ts";

const runtime = new Miniflare({
  modules: true,
  script: "export default { fetch() { return new Response('test'); } }",
  compatibilityDate: "2026-06-06",
  r2Buckets: ["ARCHIVE"],
});
let bucket: R2Bucket;
beforeAll(async () => {
  bucket = (await runtime.getR2Bucket("ARCHIVE")) as unknown as R2Bucket;
});
afterAll(async () => {
  await runtime.dispose();
});
const generation = "a".repeat(64);
const scope = {
  generation,
  network: "mainnet" as const,
  table: "extrinsics" as const,
  fileRows: [300000, 300000],
};
function hash(n: number) {
  return "0xabc" + n.toString(16).padStart(61, "0");
}
async function fixture(rows = 200000, duplicates = false) {
  const bytes = new Uint8Array(rows * 40);
  for (let row = 0; row < rows; row++) {
    const value = hash(duplicates ? Math.floor(row / 2) * 2 : row * 2).slice(2);
    bytes.set(
      Uint8Array.from(value.match(/../g)!, (v) => parseInt(v, 16)),
      row * 40,
    );
    const view = new DataView(bytes.buffer, row * 40, 40);
    view.setUint32(32, row % 2, true);
    view.setUint32(36, row, true);
  }
  const key = `metagraph/indexed-history/v1/mainnet/extrinsics/generations/${generation}/hash/abc.bin`;
  const object = await bucket.put(key, bytes);
  assert.ok(object);
  const shard: HistoryHashShard = {
    version: 1,
    generation,
    network: "mainnet",
    table: "extrinsics",
    prefix: "abc",
    key,
    etag: object.etag,
    rows,
    bytes: bytes.length,
  };
  return { shard, bytes };
}
test("first, middle, last, duplicates and absent hashes use bounded conditional R2 pages", async () => {
  const { shard } = await fixture();
  for (const row of [0, 1023, 1024, 99999, 199999]) {
    const budget = parquetReadBudget();
    assert.deepEqual(
      await findHistoryHash(
        r2ParquetSource(bucket),
        shard,
        hash(row * 2)
          .toUpperCase()
          .replace("0X", "0x"),
        scope,
        budget,
      ),
      { fileId: row % 2, row },
    );
    assert.ok(budget.requests <= 9);
    assert.ok(budget.bytes <= 9 * 40960);
  }
  for (const value of [1, 199999, 400000])
    assert.equal(
      await findHistoryHash(
        r2ParquetSource(bucket),
        shard,
        hash(value),
        scope,
        parquetReadBudget(),
      ),
      null,
    );
  const duplicate = await fixture(2050, true);
  assert.deepEqual(
    await findHistoryHash(
      r2ParquetSource(bucket),
      duplicate.shard,
      hash(1024),
      scope,
      parquetReadBudget(),
    ),
    { fileId: 0, row: 1024 },
  );
  const empty = await fixture(0);
  const budget = parquetReadBudget();
  assert.equal(
    await findHistoryHash(
      r2ParquetSource(bucket),
      empty.shard,
      hash(0),
      scope,
      budget,
    ),
    null,
  );
  assert.equal(budget.requests, 0);
});
test("logical scope and physical pointer mismatches cannot answer a lookup", async () => {
  const { shard } = await fixture(2);
  for (const change of [
    { generation: "b".repeat(64) },
    { network: "testnet" },
    { table: "blocks" },
    { prefix: "abb" },
    { key: "foreign.bin" },
    { bytes: 1 },
  ])
    await assert.rejects(
      findHistoryHash(
        r2ParquetSource(bucket),
        { ...shard, ...change },
        hash(0),
        scope,
        parquetReadBudget(),
      ),
      /scope mismatch/,
    );
  await assert.rejects(
    findHistoryHash(
      r2ParquetSource(bucket),
      shard,
      "invalid",
      scope,
      parquetReadBudget(),
    ),
    /Invalid history hash/,
  );
  for (const fileRows of [[], [NaN], [0]])
    await assert.rejects(
      findHistoryHash(
        r2ParquetSource(bucket),
        shard,
        hash(0),
        { ...scope, fileRows },
        parquetReadBudget(),
      ),
      /outside its generation/,
    );
  await assert.rejects(
    findHistoryHash(
      r2ParquetSource(bucket),
      shard,
      hash(2),
      { ...scope, fileRows: [10, 1] },
      parquetReadBudget(),
    ),
    /outside its generation/,
  );
});
test("missing, replaced, truncated, foreign-prefix and budget-exceeding shards throw rather than report absence", async () => {
  const { shard, bytes } = await fixture(2050);
  const source = r2ParquetSource(bucket);
  for (const budget of [parquetReadBudget(1), parquetReadBudget(1000000, 1)])
    await assert.rejects(
      findHistoryHash(source, shard, hash(0), scope, budget),
      /budget exceeded/,
    );
  await assert.rejects(
    findHistoryHash(
      { read: async () => new ArrayBuffer(1) },
      shard,
      hash(0),
      scope,
      parquetReadBudget(),
    ),
    /Truncated/,
  );
  bytes.fill(0, 0, bytes.length);
  const foreign = await bucket.put(shard.key, bytes);
  assert.ok(foreign);
  await assert.rejects(
    findHistoryHash(
      source,
      { ...shard, etag: foreign.etag },
      hash(0),
      scope,
      parquetReadBudget(),
    ),
    /foreign prefix/,
  );
  await assert.rejects(
    findHistoryHash(source, shard, hash(0), scope, parquetReadBudget()),
    /missing or changed/,
  );
  await bucket.delete(shard.key);
  await assert.rejects(
    findHistoryHash(source, shard, hash(0), scope, parquetReadBudget()),
    /missing or changed/,
  );
});
