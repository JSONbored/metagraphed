import { createHash } from "node:crypto";
import { beforeEach, expect, test, vi } from "vitest";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { createImmutableHistoryMetadataReader } from "../src/immutable-history-metadata.ts";
import { resetModuleState } from "../src/module-state-registry.ts";
import {
  boundedParquetBuffer,
  parquetReadBudget,
  r2ParquetSource,
} from "../src/indexed-parquet.ts";

beforeEach(resetModuleState);

function fixture(seed = 0, length = 32) {
  const bytes = new Uint8Array(length).fill(seed).buffer;
  const hash = createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
  const etag = createHash("md5").update(new Uint8Array(bytes)).digest("hex");
  return {
    bytes,
    key: `metagraph/indexed-history/v1/mainnet/events/generations/${"a".repeat(64)}/nodes/${hash}.json`,
    etag,
    length,
    read: vi.fn(async () => bytes),
  };
}
type Reader = ReturnType<typeof createImmutableHistoryMetadataReader>;
function load(reader: Reader, f: ReturnType<typeof fixture>) {
  return reader(f.key, f.etag, 0, f.length, f.read);
}
function deferred() {
  let resolve!: (bytes: ArrayBuffer) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<ArrayBuffer>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("completed bytes are shared across operations but buffers remain private", async () => {
  const bucket = {},
    f = fixture(1),
    expected = f.bytes.slice(0);
  const reader = createImmutableHistoryMetadataReader(bucket);
  const first = await load(reader, f);
  new Uint8Array(first).fill(7);
  new Uint8Array(f.bytes).fill(9);
  const second = await load(createImmutableHistoryMetadataReader(bucket), f);
  expect(second).toEqual(expected);
  new Uint8Array(second).fill(11);
  expect(await load(reader, f)).toEqual(expected);
  expect(f.read).toHaveBeenCalledTimes(1);
});

test("binding, path, ETag and length identities never collide", async () => {
  const f = fixture(),
    reader = createImmutableHistoryMetadataReader({});
  await load(reader, f);
  await load(createImmutableHistoryMetadataReader({}), f);
  await load(reader, { ...f, etag: "b".repeat(32) });
  await load(reader, { ...f, key: f.key.replace("mainnet", "testnet") });
  await load(reader, { ...f, key: f.key.replace("/events/", "/extrinsics/") });
  await load(reader, { ...f, length: f.length + 1 });
  expect(f.read).toHaveBeenCalledTimes(6);
  await load(reader, f);
  expect(f.read).toHaveBeenCalledTimes(6);
});

test("mutable, non-directory, oversized and invalid ranges always read fresh", async () => {
  const f = fixture(),
    reader = createImmutableHistoryMetadataReader({});
  const cases: [string, string, number, number][] = [
    [f.key, f.etag, 1, f.length],
    ...[
      0,
      -1,
      1.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      128 * 1024 + 1,
    ].map((length): [string, string, number, number] => [
      f.key,
      f.etag,
      0,
      length,
    ]),
    [f.key, "not-an-etag", 0, f.length],
    [f.key, f.etag.toUpperCase(), 0, f.length],
    [f.key.replace("/nodes/", `/${"x".repeat(1024)}/`), f.etag, 0, f.length],
    [f.key.replace(/[^/]+$/, "manifest.json"), f.etag, 0, f.length],
    [f.key.replace(/[^/]+$/, "current.json"), f.etag, 0, f.length],
    [f.key.replace(".json", ".bin"), f.etag, 0, f.length],
    [f.key.replace("mainnet", "unknown"), f.etag, 0, f.length],
    [f.key.replace("indexed-history", "other-history"), f.etag, 0, f.length],
  ];
  for (const args of cases) {
    const read = vi.fn(async () => f.bytes);
    await reader(...args, read);
    await reader(...args, read);
    expect(read).toHaveBeenCalledTimes(2);
  }
});

test("hash or length mismatch never caches or changes the fresh result", async () => {
  const f = fixture(),
    reader = createImmutableHistoryMetadataReader({});
  for (const value of [
    { ...f, key: f.key.replace(/[^/]+$/, `${"0".repeat(64)}.json`) },
    { ...f, length: f.length + 1 },
  ]) {
    expect(await load(reader, value)).toEqual(f.bytes);
    expect(await load(reader, value)).toEqual(f.bytes);
  }
  expect(f.read).toHaveBeenCalledTimes(4);
});

test("one operation deduplicates pending reads and gives each waiter its own bytes", async () => {
  const f = fixture(),
    reader = createImmutableHistoryMetadataReader({}),
    pending = deferred();
  f.read.mockImplementation(() => pending.promise);
  const first = load(reader, f),
    second = load(reader, f);
  expect(f.read).toHaveBeenCalledTimes(1);
  pending.resolve(f.bytes);
  const [a, b] = await Promise.all([first, second]);
  expect(a).toEqual(b);
  expect(a).not.toBe(b);
  new Uint8Array(a).fill(1);
  expect(b).toEqual(f.bytes);
});

test("failed reads reach all waiters and remain retryable, including synchronous throws", async () => {
  const f = fixture(),
    reader = createImmutableHistoryMetadataReader({}),
    pending = deferred();
  f.read.mockImplementationOnce(() => pending.promise);
  const first = expect(load(reader, f)).rejects.toThrow("unavailable");
  const second = expect(load(reader, f)).rejects.toThrow("unavailable");
  pending.reject(new Error("unavailable"));
  await Promise.all([first, second]);
  f.read.mockImplementationOnce(() => {
    throw new Error("sync");
  });
  await expect(load(reader, f)).rejects.toThrow("sync");
  expect(await load(reader, f)).toEqual(f.bytes);
  await load(reader, f);
  expect(f.read).toHaveBeenCalledTimes(3);
});

test("different operations own pending I/O without double-counting completed entries", async () => {
  const bucket = {},
    f = fixture(0, 128 * 1024),
    pending = deferred();
  const a = createImmutableHistoryMetadataReader(bucket),
    b = createImmutableHistoryMetadataReader(bucket);
  f.read.mockImplementation(() => pending.promise);
  const first = load(a, f),
    second = load(b, f);
  expect(f.read).toHaveBeenCalledTimes(2);
  pending.resolve(f.bytes);
  await Promise.all([first, second]);
  for (let i = 1; i < 16; i++) await load(a, fixture(i, 128 * 1024));
  await load(b, f);
  expect(f.read).toHaveBeenCalledTimes(2);
});

test("pending admission is bounded globally while existing waiters can still join", async () => {
  const pending = deferred(),
    reader = createImmutableHistoryMetadataReader({});
  const values = Array.from({ length: 16 }, (_, i) => fixture(i));
  for (const f of values)
    f.read.mockImplementation(() => pending.promise.then(() => f.bytes));
  const first = load(reader, values[0]);
  const rest = values
    .slice(1)
    .map((f) => load(createImmutableHistoryMetadataReader({}), f));
  const joined = load(reader, values[0]);
  const extra = fixture(17);
  await load(reader, extra);
  await load(reader, extra);
  expect(extra.read).toHaveBeenCalledTimes(2);
  expect(values[0].read).toHaveBeenCalledTimes(1);
  pending.resolve(new ArrayBuffer(0));
  await Promise.all([first, ...rest, joined]);
  await load(reader, extra);
  await load(reader, extra);
  expect(extra.read).toHaveBeenCalledTimes(3);
});

test("the entry limit is global across buckets and refreshes least-recently-used order", async () => {
  const a = createImmutableHistoryMetadataReader({}),
    b = createImmutableHistoryMetadataReader({});
  const values = Array.from({ length: 129 }, (_, i) => fixture(i));
  await load(a, values[0]);
  for (const f of values.slice(1, 128)) await load(b, f);
  await load(a, values[0]);
  await load(b, values[128]);
  await load(a, values[0]);
  expect(values[0].read).toHaveBeenCalledTimes(1);
  await load(b, values[1]);
  expect(values[1].read).toHaveBeenCalledTimes(2);
});

test("the byte limit evicts before the entry limit when directories are large", async () => {
  const reader = createImmutableHistoryMetadataReader({});
  const values = Array.from({ length: 17 }, (_, i) => fixture(i, 128 * 1024));
  for (const f of values) await load(reader, f);
  await load(reader, values[16]);
  expect(values[16].read).toHaveBeenCalledTimes(1);
  await load(reader, values[0]);
  expect(values[0].read).toHaveBeenCalledTimes(2);
});

test("reset neither joins old pending reads nor lets their completion refill the new cache", async () => {
  const f = fixture(),
    reader = createImmutableHistoryMetadataReader({});
  const old = deferred(),
    current = deferred();
  f.read
    .mockImplementationOnce(() => old.promise)
    .mockImplementationOnce(() => current.promise);
  const first = load(reader, f);
  resetModuleState();
  const second = load(reader, f);
  old.resolve(f.bytes);
  await first;
  let settled = false;
  const joined = load(reader, f).then((bytes) => {
    settled = true;
    return bytes;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(f.read).toHaveBeenCalledTimes(2);
  current.resolve(f.bytes);
  await Promise.all([second, joined]);
  await load(reader, f);
  expect(f.read).toHaveBeenCalledTimes(2);
  resetModuleState();
  await load(reader, f);
  expect(f.read).toHaveBeenCalledTimes(3);
});

test("R2 validation failures are not cached and warm hits still consume query budgets", async () => {
  const f = fixture();
  const get = vi
    .fn()
    .mockResolvedValueOnce(null)
    .mockImplementationOnce(async () => ({
      etag: f.etag,
      range: { offset: 0, length: f.length },
      body: new Response(new Uint8Array(1)).body,
    }))
    .mockImplementation(async () => ({
      etag: f.etag,
      range: { offset: 0, length: f.length },
      body: new Response(f.bytes).body,
    }));
  const bucket = { get } as unknown as Pick<R2Bucket, "get">;
  const source = r2ParquetSource(bucket);
  await expect(source.read(f.key, f.etag, 0, f.length)).rejects.toThrow(
    "missing or changed",
  );
  await expect(source.read(f.key, f.etag, 0, f.length)).rejects.toThrow(
    "Truncated",
  );
  await source.read(f.key, f.etag, 0, f.length);
  const index = { key: f.key, etag: f.etag, bytes: f.length };
  for (const budget of [
    parquetReadBudget(f.length, 2),
    parquetReadBudget(f.length * 2, 1),
  ]) {
    const bounded = boundedParquetBuffer(
      r2ParquetSource(bucket),
      index,
      budget,
    );
    expect(await bounded.slice(0)).toEqual(f.bytes);
    expect(budget.bytes).toBe(f.length);
    expect(budget.requests).toBe(1);
    await expect(bounded.slice(0)).rejects.toThrow("budget exceeded");
  }
  expect(get).toHaveBeenCalledTimes(3);
  expect(get).toHaveBeenLastCalledWith(f.key, {
    onlyIf: { etagMatches: f.etag },
    range: { offset: 0, length: f.length },
  });
});

test("workerd shares only completed bytes across real R2 request contexts", async () => {
  const f = fixture();
  const bundled = await build({
    stdin: {
      contents: `
        import { createImmutableHistoryMetadataReader } from './src/immutable-history-metadata.ts';
        let reads = 0;
        export default { async fetch(request, env) {
          const reader = createImmutableHistoryMetadataReader(env.ARCHIVE);
          const bytes = await reader(${JSON.stringify(f.key)}, ${JSON.stringify(f.etag)}, 0, ${f.length}, async () => {
            reads++;
            const object = await env.ARCHIVE.get(${JSON.stringify(f.key)});
            while (reads < 2) await new Promise(resolve => setTimeout(resolve, 1));
            return object.arrayBuffer();
          });
          return Response.json({ reads, bytes: Array.from(new Uint8Array(bytes)) });
        }};`,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  });
  const runtime = new Miniflare({
    modules: true,
    script: bundled.outputFiles[0].text,
    compatibilityDate: "2026-06-06",
    r2Buckets: ["ARCHIVE"],
  });
  try {
    await (await runtime.getR2Bucket("ARCHIVE")).put(f.key, f.bytes);
    const responses = await Promise.all([
      runtime.dispatchFetch("https://test/"),
      runtime.dispatchFetch("https://test/"),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        reads: 2,
        bytes: Array.from(new Uint8Array(f.bytes)),
      });
    }
    const warm = await runtime.dispatchFetch("https://test/");
    expect(await warm.json()).toEqual({
      reads: 2,
      bytes: Array.from(new Uint8Array(f.bytes)),
    });
  } finally {
    await runtime.dispose();
  }
});
