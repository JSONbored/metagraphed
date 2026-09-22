import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, test } from "vitest";
import { Miniflare } from "miniflare";
import {
  buildParquetPageIndex,
  parquetFooter,
} from "../scripts/build-parquet-page-index.ts";
import {
  HistoryFileSchema,
  type HistoryGeneration,
  type HistoryObject,
} from "../schemas-src/artifacts/history-generation.ts";
import {
  loadHistoryGeneration,
  readHistoryHash,
  readHistoryRow,
  validateHistoryGeneration,
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
  generation: "a".repeat(64),
  network: "mainnet" as const,
  table: "extrinsics" as const,
};
const root = `metagraph/indexed-history/v1/mainnet/extrinsics/generations/${scope.generation}`;
const sourceIdentity = "b".repeat(64);
const hash = (n: number) => "0x" + n.toString(16).padStart(64, "0");
async function put(key: string, input: unknown): Promise<HistoryObject> {
  const raw = new TextEncoder().encode(JSON.stringify(input));
  const object = await bucket.put(key, raw);
  assert.ok(object);
  return { key, etag: object.etag, bytes: raw.length };
}
async function fixture(table: "extrinsics" | "blocks" = "extrinsics") {
  const fixtureScope = { ...scope, table };
  const fixtureRoot = `metagraph/indexed-history/v1/mainnet/${table}/generations/${scope.generation}`;
  const parts = [];
  const indexes = [];
  for (let ordinal = 0; ordinal < 2; ordinal++) {
    const raw = readFileSync(
      new URL(
        `./fixtures/parquet/history-part-${ordinal}.parquet`,
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
    const key = `metagraph/indexed-history/v1/mainnet/${table}/${sourceIdentity}/${String(ordinal).padStart(5, "0")}-${String(ordinal).repeat(64)}.parquet`;
    const object = await bucket.put(key, bytes);
    assert.ok(object);
    const index = await buildParquetPageIndex(
      file,
      key,
      object.etag,
      await parquetFooter(file),
    );
    indexes.push(index);
    parts.push({
      key,
      etag: object.etag,
      bytes: bytes.byteLength,
      rowStart: ordinal * 10,
      rows: 10,
      index: await put(key.replace(/\.parquet$/, ".page-index.json"), index),
    });
  }
  const file = HistoryFileSchema.parse({
    version: 1,
    ...fixtureScope,
    fileId: 0,
    sourceIdentity,
    rows: 20,
    parts,
  });
  const descriptor = await put(`${fixtureRoot}/files/00000.json`, file);
  const records = new Uint8Array(20 * 40);
  for (let row = 0; row < 20; row++) {
    records.set(
      Uint8Array.from(hash(row).slice(2).match(/../g)!, (x) => parseInt(x, 16)),
      row * 40,
    );
    new DataView(records.buffer).setUint32(row * 40 + 36, row, true);
  }
  const object = await bucket.put(`${fixtureRoot}/hash/000.bin`, records);
  assert.ok(object);
  const generation: HistoryGeneration = {
    version: 1,
    ...fixtureScope,
    state: "complete",
    sourceSnapshot: "1288252909363797486",
    rows: 20,
    files: [{ ...descriptor, rows: 20 }],
    shards: Array.from({ length: 4096 }, (_, i) => {
      const prefix = i.toString(16).padStart(3, "0");
      return {
        version: 1,
        ...fixtureScope,
        prefix,
        key: `${fixtureRoot}/hash/${prefix}.bin`,
        etag: i === 0 ? object.etag : "empty",
        rows: i === 0 ? 20 : 0,
        bytes: i === 0 ? records.length : 0,
      };
    }),
  };
  return { generation, file, indexes, descriptor, records };
}
test("real conditional R2 lookups cross repacked parts and preserve exact values", async () => {
  const { generation } = await fixture();
  const descriptor = await put(`${root}/manifest.json`, generation);
  const source = r2ParquetSource(bucket),
    budget = parquetReadBudget();
  const loaded = await loadHistoryGeneration(source, descriptor, scope, budget);
  for (const n of [0, 9, 10, 19]) {
    const row = await readHistoryHash(source, loaded, scope, hash(n), budget);
    assert.ok(row);
    assert.equal(row.block_number, BigInt(n));
    assert.equal(row.wide, 9007199254740992n + BigInt(n));
    assert.equal(row.nullable, n % 2 ? null : "value");
  }
  assert.equal(
    await readHistoryHash(source, loaded, scope, hash(20), budget),
    null,
  );
  assert.equal(
    await readHistoryHash(
      source,
      loaded,
      scope,
      "0xabc" + "0".repeat(61),
      budget,
    ),
    null,
  );
  assert.ok(budget.requests < 40);
  assert.ok(budget.bytes < 3 * 1024 * 1024);
  await assert.rejects(
    loadHistoryGeneration(
      source,
      { ...descriptor, key: "foreign" },
      scope,
      parquetReadBudget(),
    ),
    /pointer scope/,
  );
  await assert.rejects(
    loadHistoryGeneration(
      source,
      { ...descriptor, bytes: 9 * 1024 * 1024 },
      scope,
      parquetReadBudget(),
    ),
    /size budget/,
  );
  await assert.rejects(
    loadHistoryGeneration(
      source,
      { ...descriptor, etag: "changed" },
      scope,
      parquetReadBudget(),
    ),
    /missing or changed/,
  );
  await assert.rejects(
    readHistoryHash(source, loaded, scope, "invalid", parquetReadBudget()),
    /Invalid history hash/,
  );
});
test("incomplete generations, missing files and foreign shards cannot establish absence", async () => {
  const { generation: g } = await fixture();
  for (const change of [
    { generation: "c".repeat(64) },
    { network: "testnet" },
    { table: "blocks" },
  ])
    assert.throws(
      () => validateHistoryGeneration({ ...g, ...change }, scope),
      /scope mismatch/,
    );
  assert.throws(() =>
    validateHistoryGeneration({ ...g, state: "staging" }, scope),
  );
  assert.throws(
    () => validateHistoryGeneration({ ...g, files: [] }, scope),
    /row count/,
  );
  assert.throws(
    () => validateHistoryGeneration({ ...g, rows: 21 }, scope),
    /row count/,
  );
  const bad = structuredClone(g);
  bad.files[0].key = "foreign";
  assert.throws(
    () => validateHistoryGeneration(bad, scope),
    /descriptor scope/,
  );
  for (const change of [
    { generation: "c".repeat(64) },
    { network: "testnet" },
    { table: "blocks" },
    { prefix: "fff" },
    { key: "foreign" },
    { bytes: 1 },
  ]) {
    const bad = structuredClone(g);
    Object.assign(bad.shards[0], change);
    assert.throws(() => validateHistoryGeneration(bad, scope), /hash shard/);
  }
  const incomplete = structuredClone(g);
  incomplete.shards[0].rows = 19;
  incomplete.shards[0].bytes = 19 * 40;
  assert.throws(
    () => validateHistoryGeneration(incomplete, scope),
    /row count/,
  );
  const source = r2ParquetSource(bucket);
  for (const [file, row] of [
    [NaN, 0],
    [-1, 0],
    [1, 0],
    [0, NaN],
    [0, -1],
    [0, 20],
  ])
    await assert.rejects(
      readHistoryRow(source, g, scope, file, row, parquetReadBudget()),
      /outside generation/,
    );
  await bucket.delete(g.files[0].key);
  await assert.rejects(
    readHistoryHash(source, g, scope, hash(0), parquetReadBudget()),
    /missing or changed/,
  );
});
test("file, part and page-index identities are verified before serving any row", async () => {
  const { generation, file, indexes } = await fixture();
  const source = r2ParquetSource(bucket);
  async function fromFile(value: unknown) {
    const descriptor = await put(generation.files[0].key, value);
    return readHistoryRow(
      source,
      { ...generation, files: [{ ...descriptor, rows: 20 }] },
      scope,
      0,
      0,
      parquetReadBudget(),
    );
  }
  for (const change of [
    { generation: "c".repeat(64) },
    { network: "testnet" },
    { table: "blocks" },
    { fileId: 1 },
    { rows: 21 },
  ])
    await assert.rejects(fromFile({ ...file, ...change }), /source file scope/);
  for (const change of [
    { rowStart: 1 },
    { key: "foreign" },
    {
      key: file.parts[0].key.replace(
        "0".repeat(64) + ".parquet",
        "invalid.parquet",
      ),
    },
    { bytes: 129 * 1024 * 1024 },
    { index: { ...file.parts[0].index, key: "foreign" } },
  ]) {
    const bad = structuredClone(file);
    Object.assign(bad.parts[0], change);
    await assert.rejects(fromFile(bad), /identity or contiguity/);
  }
  await assert.rejects(
    fromFile({ ...file, parts: [file.parts[0]] }),
    /parts are incomplete/,
  );
  for (const change of [
    { key: "foreign" },
    { etag: "wrong" },
    { bytes: indexes[0].bytes + 1 },
    { rows: 11 },
    { groups: [{ ...indexes[0].groups[0], rows: 513 }] },
  ]) {
    const bad = structuredClone(file);
    bad.parts[0].index = await put(bad.parts[0].index.key, {
      ...indexes[0],
      ...change,
    });
    await assert.rejects(fromFile(bad), /bounded part/);
  }
});
test("a valid physical pointer cannot substitute another logical hash", async () => {
  const { generation, records } = await fixture();
  new DataView(records.buffer).setUint32(36, 1, true);
  const object = await bucket.put(generation.shards[0].key, records);
  assert.ok(object);
  generation.shards[0].etag = object.etag;
  await assert.rejects(
    readHistoryHash(
      r2ParquetSource(bucket),
      generation,
      scope,
      hash(0),
      parquetReadBudget(),
    ),
    /different logical record/,
  );
  const block = await fixture("blocks");
  const row = await readHistoryHash(
    r2ParquetSource(bucket),
    block.generation,
    { ...scope, table: "blocks" },
    hash(15),
    parquetReadBudget(),
  );
  assert.equal(row?.block_hash, hash(15));
});
