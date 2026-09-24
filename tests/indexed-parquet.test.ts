import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, test, vi } from "vitest";
import { Miniflare } from "miniflare";
import { parquetReadObjects } from "hyparquet/src/index.js";
import * as parquet from "hyparquet/src/index.js";
import * as thrift from "hyparquet/src/thrift.js";
import { decompress } from "fzstd";
import {
  buildParquetPageIndex,
  parquetFooter,
  sequentialParquetBuffer,
} from "../scripts/build-parquet-page-index.ts";
import {
  boundedParquetBuffer,
  parquetReadBudget,
  readIndexedParquet,
  reserveParquetPageMemory,
  r2ParquetSource,
  validateParquetPageIndex,
} from "../src/indexed-parquet.ts";
import type { ParquetPageIndex } from "../schemas-src/artifacts/parquet-page-index.ts";

// Keep the real decoder for parity tests; configurable copies allow isolated
// malformed-decoder/footer tests without hand-encoding invalid Thrift files.
vi.mock("hyparquet/src/index.js", async (original) => ({
  ...(await original<typeof parquet>()),
}));
vi.mock("hyparquet/src/thrift.js", async (original) => ({
  ...(await original<typeof thrift>()),
}));

const runtime = new Miniflare({
  modules: true,
  script: "export default { fetch() { return new Response('test'); } }",
  compatibilityDate: "2026-06-06",
  r2Buckets: ["ARCHIVE"],
});

test("R2 adapter refuses malformed range responses and truncated bodies", async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const cases = [
    { etag: "expected", range: { offset: 0, length: 4 } },
    {
      etag: "wrong",
      range: { offset: 0, length: 4 },
      body: new Response(bytes).body,
    },
    { etag: "expected", body: new Response(bytes).body },
    { etag: "expected", range: { suffix: 4 }, body: new Response(bytes).body },
    {
      etag: "expected",
      range: { offset: 1, length: 4 },
      body: new Response(bytes).body,
    },
    {
      etag: "expected",
      range: { offset: 0, length: 3 },
      body: new Response(bytes).body,
    },
    {
      etag: "expected",
      range: { offset: 0, length: 4 },
      body: new Response(bytes.subarray(0, 1)).body,
    },
  ];
  for (const value of cases) {
    const source = r2ParquetSource({
      async get() {
        return value;
      },
    } as unknown as Pick<R2Bucket, "get">);
    await assert.rejects(
      source.read("key", "expected", 0, 4),
      /Parquet source/,
    );
  }
});

test("malformed footer metadata and incomplete decoder results fail closed", async () => {
  const { index } = await indexed();
  const original = validateParquetPageIndex(index).metadata;
  const changes: ((
    metadata: typeof original,
    index: ParquetPageIndex,
  ) => void)[] = [
    (m) => {
      m.schema[1].num_children = 1;
    },
    (m) => {
      m.schema[1].repetition_type = "REPEATED";
    },
    (m) => {
      delete m.row_groups[0].columns[0].meta_data;
    },
    (m) => {
      m.row_groups[0].columns[0].meta_data!.path_in_schema.push("nested");
    },
    (m) => {
      m.row_groups[0].columns[0].file_path = "other.parquet";
    },
    (m, i) => {
      m.row_groups[0].num_rows++;
      i.groups[0].rows++;
      for (const pages of Object.values(i.groups[0].columns))
        pages.at(-1)!.rows++;
    },
  ];
  const metadataSpy = vi.spyOn(parquet, "parquetMetadata");
  try {
    for (const change of changes) {
      const metadata = structuredClone(original),
        input = structuredClone(index);
      change(metadata, input);
      metadataSpy.mockReturnValue(metadata);
      assert.throws(() => validateParquetPageIndex(input), /Parquet/);
    }
  } finally {
    metadataSpy.mockRestore();
  }
  const decode = vi.spyOn(parquet, "parquetReadObjects").mockResolvedValue([]);
  try {
    await assert.rejects(
      readIndexedParquet(
        r2ParquetSource(bucket),
        index,
        0,
        1,
        ["id"],
        parquetReadBudget(),
      ),
      /Incomplete indexed/,
    );
  } finally {
    decode.mockRestore();
  }
});

test("compressed pages cannot exceed decoded allocation limits", async () => {
  const { index, bytes } = await indexed();
  const page = index.groups[0].columns.id[0];
  const data = bytes.slice(page.offset, page.offset + page.bytes);
  for (const saturated of [
    { decodedBytes: 32 * 1024 * 1024 },
    { values: 1_000_000 },
  ]) {
    assert.throws(
      () =>
        reserveParquetPageMemory(data, {
          ...parquetReadBudget(),
          ...saturated,
        }),
      /memory budget exceeded/,
    );
  }
  const parse = vi.spyOn(thrift, "deserializeTCompactProtocol");
  const base = { field_1: 0, field_2: 1, field_3: 1, field_5: { field_1: 1 } };
  const changes = [
    { field_1: 9 },
    { field_3: "1" },
    { field_3: 1.5 },
    { field_3: -1 },
    { field_3: 3 },
    { field_2: "1" },
    { field_2: 1.5 },
    { field_2: -1 },
    { field_5: undefined },
    { field_5: { field_1: 1.5 } },
    { field_5: { field_1: -1 } },
  ];
  try {
    for (const change of changes) {
      parse.mockImplementation((reader) => {
        reader.offset++;
        return { ...base, ...change };
      });
      assert.throws(
        () => reserveParquetPageMemory(new ArrayBuffer(2), parquetReadBudget()),
        /Invalid Parquet page header/,
      );
    }
  } finally {
    parse.mockRestore();
  }
});

test("compact groups coalesce columns but a wide column span retains page pruning", async () => {
  const { index, bytes } = await indexed();
  const source = r2ParquetSource(bucket);
  const budget = parquetReadBudget();
  await readIndexedParquet(
    source,
    index,
    1999,
    2000,
    ["id", "label", "enabled", "amount"],
    budget,
  );
  assert.equal(budget.requests, 1);

  // Model a compact group with a large unselected payload between columns.
  // The real fixture still supplies the selected id page; only the planning
  // metadata and decoder request are replaced for this layout boundary.
  const metadata = validateParquetPageIndex(index).metadata;
  const last = index.groups.at(-1)!;
  const size = 2 * 1024 * 1024;
  metadata.row_groups
    .at(-1)!
    .columns.at(-1)!.meta_data!.total_compressed_size += BigInt(size);
  last.columns.amount.at(-1)!.bytes += size;
  index.bytes += size;
  const footer = vi.spyOn(parquet, "parquetMetadata").mockReturnValue(metadata);
  const page = last.columns.id[0];
  const decode = vi
    .spyOn(parquet, "parquetReadObjects")
    .mockImplementation(async (options) => {
      assert.deepEqual(
        await options.file.slice(page.offset, page.offset + page.bytes),
        bytes.slice(page.offset, page.offset + page.bytes),
      );
      return [{ id: 1n }];
    });
  try {
    const bounded = parquetReadBudget();
    await readIndexedParquet(
      source,
      index,
      1999,
      2000,
      ["id", "amount"],
      bounded,
    );
    assert.equal(bounded.bytes, page.bytes);
  } finally {
    footer.mockRestore();
    decode.mockRestore();
  }
});
test("compact history groups share adjacent reads without changing exact selected rows", async () => {
  const raw = readFileSync(
    new URL("./fixtures/parquet/history-events-0.parquet", import.meta.url),
  );
  const bytes = raw.buffer.slice(
    raw.byteOffset,
    raw.byteOffset + raw.byteLength,
  );
  const file = {
    byteLength: bytes.byteLength,
    slice: (start: number, end?: number) => bytes.slice(start, end),
  };
  const object = await bucket.put("compact-history", bytes);
  assert.ok(object);
  const index = await buildParquetPageIndex(
    file,
    "compact-history",
    object.etag,
    await parquetFooter(file),
  );
  const columns = ["block_number", "observed_at", "nullable"];
  const baseline = await parquetReadObjects({
    file,
    columns,
    compressors: { ZSTD: (b) => decompress(b) },
  });
  const budget = parquetReadBudget();
  const rows = await readIndexedParquet(
    r2ParquetSource(bucket),
    index,
    0,
    10,
    columns,
    budget,
  );
  assert.deepEqual(rows, baseline);
  assert.equal(budget.requests, 1);
  const { metadata } = validateParquetPageIndex(index);
  const selected = metadata.row_groups
    .flatMap((group) => group.columns)
    .filter((column) => columns.includes(column.meta_data!.path_in_schema[0]))
    .reduce(
      (sum, column) => sum + Number(column.meta_data!.total_compressed_size),
      0,
    );
  assert.ok(budget.bytes <= selected * 2);
});

test("compact ranges omit wide payloads and retain narrow-column parity", async () => {
  const raw = readFileSync(
    new URL("./fixtures/parquet/compact-ranges.parquet", import.meta.url),
  );
  const bytes = raw.buffer.slice(
    raw.byteOffset,
    raw.byteOffset + raw.byteLength,
  );
  const file = {
    byteLength: bytes.byteLength,
    slice: (start: number, end?: number) => bytes.slice(start, end),
  };
  const object = await bucket.put("compact-ranges", bytes);
  assert.ok(object);
  const index = await buildParquetPageIndex(
    file,
    "compact-ranges",
    object.etag,
    await parquetFooter(file),
  );
  const columns = ["id", "label", "amount"];
  const baseline = await parquetReadObjects({
    file,
    columns,
    compressors: { ZSTD: (b) => decompress(b) },
  });
  const source = r2ParquetSource(bucket);
  const budget = parquetReadBudget();
  const rows = await readIndexedParquet(
    source,
    index,
    0,
    2048,
    columns,
    budget,
  );
  assert.deepEqual(rows, baseline);
  assert.ok(budget.requests < index.groups.length * columns.length);
  assert.ok(budget.bytes < bytes.byteLength / 3);
});

let bucket: R2Bucket;
beforeAll(async () => {
  // Miniflare's bridge uses undici Headers in unused metadata methods.
  bucket = (await runtime.getR2Bucket("ARCHIVE")) as unknown as R2Bucket;
});
afterAll(async () => {
  await runtime.dispose();
});

function fixture(codec = "v1-zstd"): ArrayBuffer {
  const bytes = readFileSync(
    new URL(`./fixtures/parquet/flat-${codec}.parquet`, import.meta.url),
  );
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
}

async function indexed(codec = "v1-zstd") {
  const bytes = fixture(codec);
  const file = {
    byteLength: bytes.byteLength,
    slice: (start: number, end?: number) => bytes.slice(start, end),
  };
  const object = await bucket.put(codec, bytes);
  assert.ok(object);
  const index = await buildParquetPageIndex(
    file,
    codec,
    object.etag,
    await parquetFooter(file),
  );
  return { bytes, file, index };
}

describe("indexed Parquet uses the actual decoder and R2 conditional ranges", () => {
  for (const codec of ["v1-zstd", "v2-snappy"]) {
    test(`${codec}: point and cross-group reads preserve nulls, dictionaries and exact integers`, async () => {
      const { bytes, file, index } = await indexed(codec);
      const baseline = await parquetReadObjects({
        file,
        compressors: { ZSTD: (b) => decompress(b) },
      });
      assert.equal(baseline.length, 2000);
      assert.equal(baseline[0].id, 9007199254740993n);
      assert.equal(baseline[0].label, null);
      assert.equal(baseline[0].amount, null);
      assert.equal(index.groups.length, 3);
      assert.ok(index.groups[0].columns.id.length > 2);
      for (const [start, end] of [
        [0, 1],
        [1000, 1001],
        [1999, 2000],
        [795, 805],
      ]) {
        const budget = parquetReadBudget();
        const rows = await readIndexedParquet(
          r2ParquetSource(bucket),
          index,
          start,
          end,
          ["id", "label", "enabled", "amount"],
          budget,
        );
        assert.deepEqual(rows, baseline.slice(start, end));
        assert.ok(
          budget.bytes < bytes.byteLength / 2,
          `${budget.bytes} must prune whole-file reads`,
        );
        assert.ok(budget.requests < 16);
      }
      const budget = parquetReadBudget();
      assert.deepEqual(
        await readIndexedParquet(
          r2ParquetSource(bucket),
          index,
          63,
          66,
          ["label"],
          budget,
        ),
        baseline.slice(63, 66).map(({ label }) => ({ label })),
      );
      assert.ok(budget.bytes < 1500);
    });
  }

  test("a missing or replaced R2 object cannot answer an old physical row", async () => {
    const { index } = await indexed();
    const read = () =>
      readIndexedParquet(
        r2ParquetSource(bucket),
        index,
        0,
        1,
        ["id"],
        parquetReadBudget(),
      );
    await bucket.delete(index.key);
    await assert.rejects(read(), /missing or changed/);
    await bucket.put(index.key, "replacement");
    await assert.rejects(read(), /missing or changed/);
  });

  test("budgets are shared across files and reserve before parallel GETs", async () => {
    const { index } = await indexed();
    const source = r2ParquetSource(bucket);
    await assert.rejects(
      readIndexedParquet(source, index, 0, 1, ["id"], parquetReadBudget(1)),
      /budget exceeded/,
    );
    await assert.rejects(
      readIndexedParquet(
        source,
        index,
        0,
        1,
        ["id", "label"],
        parquetReadBudget(100000, 1),
      ),
      /budget exceeded/,
    );
    const budget = parquetReadBudget(100000, 1);
    const first = boundedParquetBuffer(source, index, budget);
    const second = boundedParquetBuffer(source, index, budget);
    const results = await Promise.allSettled([
      first.slice(0, 4),
      second.slice(0, 4),
    ]);
    assert.equal(results[0].status, "fulfilled");
    assert.equal(results[1].status, "rejected");
    assert.equal(budget.requests, 1);
    assert.equal(budget.bytes, 4);
  });
});

test("streaming builder matches random-access builder across arbitrary chunk boundaries", async () => {
  const { bytes, index, file } = await indexed();
  for (const size of [1, 127, 4096, 32768]) {
    let cursor = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (cursor === bytes.byteLength) {
          controller.close();
          return;
        }
        const end = Math.min(cursor + size, bytes.byteLength);
        controller.enqueue(new Uint8Array(bytes.slice(cursor, end)));
        cursor = end;
      },
    });
    const sequential = sequentialParquetBuffer(stream, bytes.byteLength);
    try {
      assert.deepEqual(
        await buildParquetPageIndex(
          sequential,
          index.key,
          index.etag,
          await parquetFooter(file),
        ),
        index,
      );
    } finally {
      await sequential.close();
    }
  }
});

test("stream adapter discards large payload gaps and detects invalid or truncated reads", async () => {
  const bytes = Uint8Array.from({ length: 1024 * 1024 }, (_, i) => i % 251);
  function stream(length = bytes.length) {
    let at = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (at >= length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(at, Math.min(at + 4096, length)));
        at += 4096;
      },
    });
  }
  const file = sequentialParquetBuffer(stream(), bytes.length);
  try {
    for (const [start, end] of [
      [0, 4],
      [2, 8],
      [100000, 100064],
      [100003, 110000],
      [1048570, 1048576],
    ])
      assert.deepEqual(
        new Uint8Array(await file.slice(start, end)),
        bytes.slice(start, end),
      );
    for (const [start, end] of [
      [0, 4],
      [1048570, 1048569],
      [1048570, 1048577],
    ])
      await assert.rejects(
        Promise.resolve().then(() => file.slice(start, end)),
        /Invalid sequential/,
      );
  } finally {
    await file.close();
  }
  const truncated = sequentialParquetBuffer(stream(5000), bytes.length);
  try {
    await assert.rejects(
      Promise.resolve().then(() => truncated.slice(8000, 8100)),
      /Truncated/,
    );
  } finally {
    await truncated.close();
  }
  const wide = sequentialParquetBuffer(stream(), bytes.length);
  try {
    await assert.rejects(
      Promise.resolve().then(() => wide.slice(0)),
      /Invalid sequential/,
    );
  } finally {
    await wide.close();
  }
  await assert.rejects(
    parquetFooter({ byteLength: 4, slice: () => new ArrayBuffer(4) }),
    /too small/,
  );
  await assert.rejects(
    parquetFooter({ byteLength: 20, slice: () => new ArrayBuffer(8) }),
    /Invalid Parquet footer/,
  );
});

test("index structure, selections and decoder byte ranges reject invalid input before storage reads", async () => {
  const { index } = await indexed();
  const source = {
    async read(): Promise<ArrayBuffer> {
      throw new Error("Unexpected storage read");
    },
  };
  const mutations: ((x: ParquetPageIndex) => void)[] = [
    (x) => {
      x.rows++;
    },
    (x) => {
      x.bytes = 12;
    },
    (x) => {
      x.groups.pop();
    },
    (x) => {
      x.groups[0].rows++;
    },
    (x) => {
      delete x.groups[0].columns.id;
    },
    (x) => {
      x.groups[0].columns.other = x.groups[0].columns.id;
      delete x.groups[0].columns.id;
    },
    (x) => {
      x.groups[0].columns.id = [];
    },
    (x) => {
      x.groups[0].columns.id[0].row = 1;
    },
    (x) => {
      x.groups[0].columns.id[0].offset++;
    },
    (x) => {
      x.groups[0].columns.id[0].bytes = x.bytes;
    },
    (x) => {
      x.groups[0].columns.id.at(-1)!.rows++;
    },
    (x) => {
      x.groups[0].columns.id.at(-1)!.bytes--;
    },
  ];
  assert.throws(() => validateParquetPageIndex({}), /./);
  assert.throws(
    () => validateParquetPageIndex({ ...index, footer: "!".repeat(20) }),
    /./,
  );
  for (const mutate of mutations) {
    const changed = structuredClone(index);
    mutate(changed);
    await assert.rejects(
      readIndexedParquet(source, changed, 0, 1, ["id"], parquetReadBudget()),
      /Parquet/,
    );
  }
  for (const [start, end, columns] of [
    [-1, 1, ["id"]],
    [0.5, 1, ["id"]],
    [0, NaN, ["id"]],
    [1, 1, ["id"]],
    [0, 2001, ["id"]],
    [0, 1, []],
    [0, 1, ["id", "id"]],
    [0, 1, ["absent"]],
  ] as [number, number, string[]][]) {
    await assert.rejects(
      readIndexedParquet(
        source,
        index,
        start,
        end,
        columns,
        parquetReadBudget(),
      ),
      /Invalid indexed Parquet selection/,
    );
  }
  const file = boundedParquetBuffer(source, index, parquetReadBudget());
  for (const [start, end] of [
    [NaN, 4],
    [0, 3.5],
    [-1, 1],
    [0, index.bytes + 1],
    [4, 4],
  ])
    await assert.rejects(
      Promise.resolve().then(() => file.slice(start, end)),
      /Invalid Parquet byte range/,
    );
  for (const [bytes, requests] of [
    [NaN, 1],
    [0, 1],
    [1, 1.5],
    [1, 0],
  ])
    assert.throws(
      () => parquetReadBudget(bytes, requests),
      /Invalid Parquet read budget/,
    );
  const truncated = boundedParquetBuffer(
    {
      async read() {
        return new ArrayBuffer(1);
      },
    },
    index,
    parquetReadBudget(),
  );
  await assert.rejects(Promise.resolve(truncated.slice(0, 4)), /Truncated/);
  const whole = boundedParquetBuffer(
    {
      async read(_key, _etag, _offset, length) {
        return new ArrayBuffer(length);
      },
    },
    index,
    parquetReadBudget(),
  );
  assert.equal((await whole.slice(0)).byteLength, index.bytes);
});
