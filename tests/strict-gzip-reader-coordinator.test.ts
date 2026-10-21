import { EventEmitter } from "node:events";
import { afterAll, afterEach, expect, test, vi } from "vitest";
import {
  readStrictGzip,
  type StrictGzipReader,
} from "../src/strict-gzip-reader.ts";
import { gzip } from "./helpers/strict-gzip-corpus.ts";

/**
 * Isolated lifecycle/coordinator tests, not decompression or resource evidence.
 * Main's CI separates files using vi.mock from shared-module test files.
 * Only the factory is doubled; framing fixtures and CRC32 remain real.
 */
const control = vi.hoisted(() => ({
  factory: undefined as undefined | ((options: unknown) => unknown),
}));

vi.mock("node:zlib", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:zlib")>();
  return {
    ...actual,
    createInflateRaw(options: unknown) {
      if (!control.factory)
        throw new Error(
          "Coordinator double requires an explicit per-test factory",
        );
      return control.factory(options);
    },
  };
});

type WriteCallback = (error?: Error | null) => void;

/** Models synchronous event timing at the codec boundary, not an inflater. */
class ControlledCodec extends EventEmitter {
  readableLength = 0;
  bytesWritten: number;
  destroyed = false;
  destroyCalls = 0;
  endCalls = 0;
  readonly reads: number[] = [];
  readonly writes: number[] = [];
  writeCallback: WriteCallback | undefined;
  onRead: ((size: number) => Uint8Array | null) | undefined;
  onWrite: ((callback: WriteCallback) => void) | undefined;
  onEnd: ((callback: WriteCallback) => void) | undefined;

  constructor(consumedDeflateBytes: number) {
    super();
    this.bytesWritten = consumedDeflateBytes;
  }

  read(size: number) {
    this.reads.push(size);
    return this.onRead?.(size) ?? null;
  }

  write(input: Uint8Array, callback: WriteCallback) {
    this.writes.push(input.byteLength);
    this.writeCallback = callback;
    this.onWrite?.(callback);
    return true;
  }

  end(callback: WriteCallback) {
    this.endCalls++;
    this.onEnd?.(callback);
    return this;
  }

  destroy() {
    this.destroyCalls++;
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit("close");
    }
    return this;
  }
}

const activeReaders = new Set<StrictGzipReader>();
const activeCodecs = new Set<ControlledCodec>();

function controlled(data = Buffer.alloc(0)) {
  const wire = gzip(data);
  const codec = new ControlledCodec(wire.length - 18);
  activeCodecs.add(codec);
  control.factory = (options) => {
    expect(options).toEqual({
      chunkSize: 8192,
      readableHighWaterMark: 8192,
      writableHighWaterMark: 4096,
    });
    return codec;
  };
  const reader = readStrictGzip(wire);
  activeReaders.add(reader);
  return { reader, codec, wire };
}

afterEach(() => {
  for (const reader of activeReaders) reader.cancel();
  for (const codec of activeCodecs) codec.removeAllListeners();
  activeReaders.clear();
  activeCodecs.clear();
  control.factory = undefined;
});

afterAll(() => {
  vi.doUnmock("node:zlib");
});

test("a failed write callback wakes a pending read and preserves its error", async () => {
  const { reader, codec, wire } = controlled();
  const pending = reader.next();
  const refused = expect(pending).rejects.toBeDefined();
  expect(codec.writes).toEqual([wire.length - 10]);
  expect(codec.writeCallback).toBeTypeOf("function");
  const error = new Error("controlled native write failure");
  codec.writeCallback!(error);
  await refused;
  await expect(pending).rejects.toBe(error);
  expect(codec.destroyed).toBe(true);
  expect(codec.endCalls).toBe(0);
  expect(codec.writes).toHaveLength(1);
  await expect(reader.next()).resolves.toEqual({
    done: true,
    value: undefined,
  });
});

test("synchronous read cancellation wins over an incidental error before input", async () => {
  const { reader, codec } = controlled();
  codec.onRead = () => {
    codec.emit("error", new Error("incidental error during cancellation"));
    reader.cancel();
    return null;
  };
  await expect(reader.next()).resolves.toEqual({
    done: true,
    value: undefined,
  });
  expect(codec.reads).toEqual([0]);
  expect(codec.writes).toEqual([]);
  expect(codec.endCalls).toBe(0);
  expect(codec.destroyed).toBe(true);
});

test("an error emitted synchronously by read prevents any input admission", async () => {
  const { reader, codec } = controlled();
  const error = new Error("controlled native read failure");
  codec.onRead = () => {
    codec.emit("error", error);
    return null;
  };
  await expect(reader.next()).rejects.toBe(error);
  expect(codec.reads).toEqual([0]);
  expect(codec.writes).toEqual([]);
  expect(codec.endCalls).toBe(0);
  expect(codec.destroyed).toBe(true);
});

test("output made ready by a null read is drained before another write or end", async () => {
  const data = Buffer.from("x");
  const { reader, codec, wire } = controlled(data);
  codec.onWrite = (callback) => callback();
  codec.onRead = (size) => {
    if (codec.reads.length === 2) {
      // Model a native continuation started by read(0): it fills readable
      // state but this read still returns null. No asynchronous queue is added.
      expect(size).toBe(0);
      codec.readableLength = data.byteLength;
      return null;
    }
    if (codec.reads.length === 3) {
      expect(size).toBe(data.byteLength);
      codec.readableLength = 0;
      return data;
    }
    return null;
  };
  await expect(reader.next()).resolves.toEqual({ done: false, value: data });
  expect(codec.reads).toEqual([0, 0, 1]);
  expect(codec.writes).toEqual([wire.length - 10]);
  expect(codec.endCalls).toBe(0);
  codec.emit("end");
  await expect(reader.next()).resolves.toEqual({
    done: true,
    value: undefined,
  });
  expect(codec.destroyed).toBe(true);
});

test("synchronous no-output callbacks progress without losing the wakeup", async () => {
  const { reader, codec, wire } = controlled();
  codec.onWrite = (callback) => callback();
  codec.onEnd = (callback) => {
    callback();
    codec.emit("end");
  };
  await expect(reader.next()).resolves.toEqual({
    done: true,
    value: undefined,
  });
  expect(codec.reads).toEqual([0, 0, 0]);
  expect(codec.writes).toEqual([wire.length - 10]);
  expect(codec.endCalls).toBe(1);
  expect(codec.destroyed).toBe(true);
});
