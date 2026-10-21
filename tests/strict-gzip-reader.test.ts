import { createHash } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import {
  readStrictGzip,
  type StrictGzipReader,
} from "../src/strict-gzip-reader.ts";
import {
  gzip,
  smallAndFramingFixtures,
  stored,
} from "./helpers/strict-gzip-corpus.ts";

// Direct host-V8 coverage of the primitive. These tests do not substitute for
// workerd backpressure/resource evidence or claim a Node-to-workerd memory bound.
// No mock registry, module-global native guard, or application state is modified.
const openReaders = new Set<StrictGzipReader>();

function open(wire: Uint8Array) {
  const reader = readStrictGzip(wire);
  openReaders.add(reader);
  return reader;
}

afterEach(async () => {
  for (const reader of openReaders) reader.cancel();
  openReaders.clear();
  // Give already-attached native error/close listeners an event-loop turn.
  // Do not wait for an input callback from a destroyed paused inflater.
  await new Promise<void>((resolve) => setImmediate(resolve));
});

async function consume(wire: Uint8Array) {
  const reader = open(wire);
  const hash = createHash("sha256");
  let bytes = 0;
  let maxChunk = 0;
  try {
    for await (const chunk of reader) {
      bytes += chunk.byteLength;
      maxChunk = Math.max(maxChunk, chunk.byteLength);
      hash.update(chunk);
    }
    return { bytes, maxChunk, sha256: hash.digest("hex") };
  } finally {
    reader.cancel();
  }
}

for (const sample of smallAndFramingFixtures()) {
  test(`host primitive: ${sample.name}`, async () => {
    if (!sample.accepted) {
      await expect(consume(sample.wire)).rejects.toThrow();
      return;
    }
    const result = await consume(sample.wire);
    expect(result.bytes).toBe(sample.expectedBytes);
    expect(result.sha256).toBe(sample.expectedSha256);
    expect(result.maxChunk).toBeLessThanOrEqual(8192);
  });
}

test("header rejection is synchronous and does not create a returned reader", () => {
  expect(() => open(new Uint8Array([0x1f, 0x8b]))).toThrow(
    "Invalid gzip stream",
  );
  expect(openReaders.size).toBe(0);
});

test("cancel before any demand is synchronous and idempotent", async () => {
  const reader = open(gzip(Buffer.from("unused")));
  expect(reader[Symbol.asyncIterator]()).toBe(reader);
  expect(reader.cancel()).toBeUndefined();
  reader.cancel();
  await expect(reader.next()).resolves.toEqual({
    done: true,
    value: undefined,
  });
  await expect(reader.return()).resolves.toEqual({
    done: true,
    value: undefined,
  });
});

for (const method of ["cancel", "return"] as const) {
  test(`${method} interrupts a pending native read; concurrent demand rejects`, async () => {
    // Genuine no-output stored blocks. Node's native write callback is async;
    // a first pending next() cannot reach the end synchronously.
    const empty = Buffer.alloc(0);
    const reader = open(gzip(empty, { raw: stored(empty, 20_000) }));
    const first = reader.next();
    await expect(reader.next()).rejects.toThrow("Concurrent gzip read");
    if (method === "cancel") expect(reader.cancel()).toBeUndefined();
    else
      await expect(reader.return()).resolves.toEqual({
        done: true,
        value: undefined,
      });
    await expect(first).resolves.toEqual({ done: true, value: undefined });
    await expect(reader.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });
}

test("return after a delivered chunk does not require consuming the tail", async () => {
  const reader = open(gzip(Buffer.alloc(1024 * 1024, 0x78)));
  const first = await reader.next();
  expect(first.done).toBe(false);
  if (first.done) throw new Error("Expected a real decoded chunk");
  expect(first.value.byteLength).toBeLessThanOrEqual(8192);
  await expect(reader.return()).resolves.toEqual({
    done: true,
    value: undefined,
  });
  await expect(reader.next()).resolves.toEqual({
    done: true,
    value: undefined,
  });
});

test("completed readers stay done", async () => {
  const reader = open(gzip(Buffer.alloc(0)));
  await expect(reader.next()).resolves.toEqual({
    done: true,
    value: undefined,
  });
  await expect(reader.next()).resolves.toEqual({
    done: true,
    value: undefined,
  });
  await expect(reader.return()).resolves.toEqual({
    done: true,
    value: undefined,
  });
});
