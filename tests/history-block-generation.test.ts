import { historyAssetSource } from "../src/history-asset-source.ts";
import { nativeHistoryAssetsFixture } from "./native-history-assets-fixture.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, test } from "vitest";
import { Miniflare } from "miniflare";
import {
  buildParquetPageIndex,
  parquetFooter,
} from "../scripts/build-parquet-page-index.ts";
import {
  HistoryBlockGenerationSchema,
  type HistoryObject,
} from "../schemas-src/artifacts/history-generation.ts";
import {
  loadHistoryBlockGeneration,
  readHistoryBlock,
  validateHistoryBlockGeneration,
} from "../src/history-generation.ts";
import { parquetReadBudget, r2ParquetSource } from "../src/indexed-parquet.ts";

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
const scope = {
  generation: "d".repeat(64),
  network: "testnet" as const,
  table: "chain_events" as const,
};
const root = `metagraph/indexed-history/v1/${scope.network}/${scope.table}/generations/${scope.generation}`;
async function put(key: string, value: unknown): Promise<HistoryObject> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const object = await bucket.put(key, bytes);
  assert.ok(object);
  return { key, bytes: bytes.length, etag: object.etag };
}
async function fixture() {
  const parts = [],
    sourceIdentity = "e".repeat(64);
  for (let i = 0; i < 2; i++) {
    const raw = readFileSync(
      new URL(
        `./fixtures/parquet/history-events-${i}.parquet`,
        import.meta.url,
      ),
    );
    const bytes = raw.buffer.slice(
      raw.byteOffset,
      raw.byteOffset + raw.byteLength,
    );
    const file = {
      byteLength: bytes.byteLength,
      slice: (start: number, end?: number) => bytes.slice(start, end),
    };
    const key = `metagraph/indexed-history/v1/testnet/chain_events/${sourceIdentity}/${String(i).padStart(5, "0")}-${String(i).repeat(64)}.parquet`;
    const object = await bucket.put(key, bytes);
    assert.ok(object);
    const index = await buildParquetPageIndex(
      file,
      key,
      object.etag,
      await parquetFooter(file),
    );
    parts.push({
      key,
      etag: object.etag,
      bytes: bytes.byteLength,
      rowStart: i * 10,
      rows: 10,
      index: await put(key.replace(/\.parquet$/, ".page-index.json"), index),
    });
  }
  const files = [];
  for (let fileId = 0; fileId < 2; fileId++) {
    files.push({
      ...(await put(`${root}/files/${String(fileId).padStart(5, "0")}.json`, {
        version: 1,
        ...scope,
        fileId,
        sourceIdentity,
        rows: 20,
        parts,
      })),
      rows: 20,
    });
  }
  const values = [
    [7, 0, 4, 4, 10],
    [7, 0, 8, 7, 20],
    [7, 1, 4, 4, 10],
    [7, 1, 8, 7, 20],
    [8, 0, 0, 4, 10],
    [8, 0, 15, 5, 20],
    [8, 1, 0, 4, 10],
    [8, 1, 15, 5, 20],
  ];
  const bytes = new Uint8Array(values.length * 24),
    view = new DataView(bytes.buffer);
  for (const [i, row] of values.entries()) {
    for (let col = 0; col < 4; col++)
      view.setUint32(i * 24 + col * 4, row[col], true);
    view.setBigUint64(i * 24 + 16, BigInt(row[4]), true);
  }
  const key = `${root}/blocks/0000.bin`,
    object = await bucket.put(key, bytes);
  assert.ok(object);
  const index = {
    version: 1,
    ...scope,
    state: "complete",
    rows: 40,
    runs: 8,
    shards: [
      {
        version: 1,
        ...scope,
        key,
        etag: object.etag,
        bytes: bytes.length,
        prefix: "0000",
        firstBlock: 7,
        lastBlock: 8,
        rows: 40,
        runs: 8,
      },
    ],
  };
  const blockIndex = await put(`${root}/blocks/index.json`, index);
  const generation = HistoryBlockGenerationSchema.parse({
    version: 1,
    ...scope,
    state: "complete",
    sourceSnapshot: "9007199254740993",
    rows: 40,
    files,
    blockIndex,
  });
  return { generation, index, bytes };
}
test("native block reads cross parts, retain captures and share file/page metadata", async () => {
  const { generation } = await fixture();
  const descriptor = await put(`${root}/block-manifest.json`, generation),
    budget = parquetReadBudget();
  const reads: string[] = [],
    r2 = r2ParquetSource(bucket);
  const source = {
    read: async (key: string, etag: string, offset: number, length: number) => {
      reads.push(key);
      return r2.read(key, etag, offset, length);
    },
  };
  const loaded = await loadHistoryBlockGeneration(
    source,
    descriptor,
    scope,
    budget,
  );
  const rows = await readHistoryBlock(source, loaded, scope, 7, budget);
  assert.equal(rows.length, 22);
  assert.deepEqual(
    rows.map((row) => row.wide),
    [
      ...Array.from({ length: 11 }, (_, i) => 9007199254740996n + BigInt(i)),
      ...Array.from({ length: 11 }, (_, i) => 9007199254740996n + BigInt(i)),
    ],
  );
  assert.deepEqual(
    rows.slice(0, 4).map((row) => row.observed_at),
    [10n, 10n, 10n, 10n],
  );
  assert.equal(rows[1].nullable, null);
  for (const file of loaded.files)
    assert.equal(reads.filter((key) => key === file.key).length, 1);
  const indexes = reads.filter((key) => key.endsWith(".page-index.json"));
  assert.equal(indexes.length, 4);
  assert.ok(budget.requests < 40);
  assert.ok(budget.bytes < 50000);
  reads.length = 0;
  assert.deepEqual(
    await readHistoryBlock(source, loaded, scope, 9, parquetReadBudget()),
    [],
  );
  assert.equal(reads.length, 1);
  await assert.rejects(
    readHistoryBlock(source, loaded, scope, 7, parquetReadBudget(100)),
    /budget/,
  );
  await assert.rejects(
    loadHistoryBlockGeneration(
      source,
      { ...descriptor, key: "foreign" },
      scope,
      parquetReadBudget(),
    ),
    /pointer scope/,
  );
  await assert.rejects(
    readHistoryBlock(
      source,
      { ...loaded, blockIndex: { ...loaded.blockIndex, etag: "changed" } },
      scope,
      7,
      parquetReadBudget(),
    ),
    /missing or changed/,
  );
});
test("incomplete or foreign block generations cannot establish absence", async () => {
  const { generation } = await fixture();
  for (const change of [
    { rows: 41 },
    { files: [] },
    { network: "mainnet" },
    { blockIndex: { ...generation.blockIndex, key: "foreign" } },
  ])
    assert.throws(
      () => validateHistoryBlockGeneration({ ...generation, ...change }, scope),
      /mismatch/,
    );
  assert.throws(() =>
    validateHistoryBlockGeneration({ ...generation, state: "staging" }, scope),
  );
  const wide = structuredClone(generation);
  wide.rows = Number.MAX_SAFE_INTEGER;
  wide.files[0].rows = Number.MAX_SAFE_INTEGER;
  wide.files[1].rows = 1;
  assert.throws(() => validateHistoryBlockGeneration(wide, scope), /row count/);
});
test("valid physical pointers must still match block and observation keys", async () => {
  for (const mode of ["block", "observed"]) {
    const { generation, index, bytes } = await fixture();
    const view = new DataView(bytes.buffer);
    if (mode === "block") view.setUint32(8, 0, true);
    else view.setBigUint64(16, 11n, true);
    const object = await bucket.put(index.shards[0].key, bytes);
    assert.ok(object);
    index.shards[0].etag = object.etag;
    generation.blockIndex = await put(generation.blockIndex.key, index);
    await assert.rejects(
      readHistoryBlock(
        r2ParquetSource(bucket),
        generation,
        scope,
        7,
        parquetReadBudget(),
      ),
      /different logical record/,
    );
  }
});

test("native event block lookups retain duplicates, wide values and absence after relocation", async () => {
  const { generation } = await fixture();
  const descriptor = await put(`${root}/block-manifest.json`, generation);
  const keys = new Set<string>(),
    original = r2ParquetSource(bucket);
  const source = {
    async read(key: string, etag: string, offset: number, length: number) {
      keys.add(key);
      return original.read(key, etag, offset, length);
    },
  };
  const budget = parquetReadBudget(128 * 1024 * 1024, 1024);
  const loaded = await loadHistoryBlockGeneration(
    source,
    descriptor,
    scope,
    budget,
  );
  const expected = [];
  for (const block of [7, 8, 9])
    expected.push(await readHistoryBlock(source, loaded, scope, block, budget));
  const env = await nativeHistoryAssetsFixture(bucket, keys);
  const relocated = historyAssetSource(
    env,
    {
      read: async () => {
        throw new Error("R2 fallback must not run");
      },
    },
    "NATIVE_HISTORY",
  );
  const assetBudget = parquetReadBudget(128 * 1024 * 1024, 1024);
  const assetGeneration = await loadHistoryBlockGeneration(
    relocated,
    descriptor,
    scope,
    assetBudget,
  );
  const actual = [];
  for (const block of [7, 8, 9])
    actual.push(
      await readHistoryBlock(
        relocated,
        assetGeneration,
        scope,
        block,
        assetBudget,
      ),
    );
  assert.deepEqual(actual, expected);
  assert.deepEqual(assetBudget, budget);
});
