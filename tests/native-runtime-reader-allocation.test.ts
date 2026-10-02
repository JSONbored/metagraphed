import assert from "node:assert/strict";
import { test, vi } from "vitest";
import eras from "./fixtures/native-runtime-eras-compiled.ts";
import legacy from "./fixtures/native-runtime-legacy-compiled.ts";
import {
  NativeScaleReader,
  NATIVE_RUNTIME_LIMITS,
  decodeNativeMetadata,
  unwrapNativeMetadata,
  type NativeMetadata,
} from "../src/native-runtime-metadata.ts";
import { nativeCompact, nativeHex } from "../src/native-runtime-values.ts";

class PreviousReader extends NativeScaleReader {
  override byte() {
    return Number(this.uint(1));
  }
  override text() {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      this.take(this.count(NATIVE_RUNTIME_LIMITS.text)),
    );
  }
}
class CountedPreviousReader extends PreviousReader {
  byteReads = 0;
  textReads = 0;
  override byte() {
    this.byteReads++;
    return super.byte();
  }
  override text() {
    this.textReads++;
    return super.text();
  }
}
const serialized = (value: NativeMetadata) =>
  JSON.stringify({ ...value, types: [...value.types.values()] });
const strings = (values: Uint8Array[]) =>
  nativeHex(
    Buffer.concat(
      values.flatMap((value) => [
        nativeCompact(BigInt(value.length)),
        value,
      ]),
    ),
  );

test("native byte reads retain all values and EOF without views or BigInt decoding", () => {
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
  const previous = new PreviousReader(nativeHex(bytes));
  const current = new NativeScaleReader(nativeHex(bytes));
  const views = vi.spyOn(current.bytes, "subarray");
  const integers = vi.spyOn(current, "uint");
  try {
    for (let index = 0; index < bytes.length; index++) {
      assert.equal(current.byte(), previous.byte());
      assert.equal(current.offset, previous.offset);
    }
    assert.equal(views.mock.calls.length, 0);
    assert.equal(integers.mock.calls.length, 0);
    for (const reader of [previous, current]) {
      assert.equal(reader.finish(reader.offset), 256);
      assert.throws(() => reader.byte(), /Truncated native SCALE data/);
      assert.equal(reader.offset, 256);
    }
    assert.throws(
      () => new NativeScaleReader("0x").byte(),
      /Truncated native SCALE data/,
    );
  } finally {
    vi.restoreAllMocks();
  }
});

test("reader-local text decoding retains BOMs, Unicode, empty strings and limits", () => {
  const values = ["", "\uFEFFfirst", "🌐α", "\uFEFFsecond", "A".repeat(65536)];
  const hex = strings(values.map((value) => Buffer.from(value)));
  const previous = new PreviousReader(hex);
  const current = new NativeScaleReader(hex);
  for (const value of values) {
    assert.equal(current.text(), value);
    assert.equal(previous.text(), value);
    assert.equal(current.offset, previous.offset);
  }
  assert.equal(current.finish(current.offset), previous.finish(previous.offset));
  const oversized = strings([Buffer.alloc(65537)]);
  for (const Reader of [PreviousReader, NativeScaleReader])
    assert.throws(() => new Reader(oversized).text(), /work budget/);
  for (const hex of ["0x0100", "0x01", "0x0c4142"])
    for (const Reader of [PreviousReader, NativeScaleReader])
      assert.throws(() => new Reader(hex).text());
});

test("fatal UTF-8 state cannot leak between strings or readers after errors", () => {
  const valid = Buffer.from("\uFEFF🌐");
  for (const invalid of [
    [0x80],
    [0xc0, 0xaf],
    [0xe0, 0x80, 0xaf],
    [0xed, 0xa0, 0x80],
    [0xf4, 0x90, 0x80, 0x80],
    [0xf5, 0x80, 0x80, 0x80],
    [0xe2, 0x82],
    [0xf0, 0x9f, 0x92],
    [0xff],
  ]) {
    const hex = strings([Buffer.from(invalid), valid, Buffer.from([0xac]), valid]);
    const previous = new PreviousReader(hex);
    const current = new NativeScaleReader(hex);
    for (let index = 0; index < 2; index++) {
      for (const reader of [previous, current])
        assert.throws(() => reader.text(), TypeError);
      assert.equal(current.offset, previous.offset);
      for (const reader of [previous, current])
        assert.equal(reader.text(), "\uFEFF🌐");
    }
    assert.equal(current.finish(current.offset), previous.finish(previous.offset));
    assert.equal(new NativeScaleReader(strings([valid])).text(), "\uFEFF🌐");
  }
});

test("a reader lazily constructs one decoder and byte-only readers construct none", () => {
  const Decoder = globalThis.TextDecoder;
  let constructions = 0;
  class CountedDecoder extends Decoder {
    constructor(...args: ConstructorParameters<typeof Decoder>) {
      super(...args);
      constructions++;
    }
  }
  vi.stubGlobal("TextDecoder", CountedDecoder);
  try {
    assert.equal(new NativeScaleReader("0x7f").byte(), 127);
    assert.equal(constructions, 0);
    const current = new NativeScaleReader(strings([Buffer.from("A"), Buffer.from("B")]));
    assert.equal(current.text(), "A");
    assert.equal(current.text(), "B");
    assert.equal(constructions, 1);
    assert.equal(new NativeScaleReader("0x00").text(), "");
    assert.equal(constructions, 2);
  } finally {
    vi.unstubAllGlobals();
  }
});

test("reader allocation removal preserves all 182 compiled metadata contracts", () => {
  let contracts = 0;
  for (const era of [...legacy, ...eras])
    for (const version of [14, 15] as const) {
      const hex = unwrapNativeMetadata(era[`v${version}`])!;
      assert.equal(
        serialized(decodeNativeMetadata(new NativeScaleReader(hex, NATIVE_RUNTIME_LIMITS.metadataBytes))),
        serialized(decodeNativeMetadata(new PreviousReader(hex, NATIVE_RUNTIME_LIMITS.metadataBytes))),
        `spec ${era.spec} V${version}`,
      );
      contracts++;
    }
  assert.equal(contracts, 182);
}, 60000);

test("compiled v470 fixture measures removed byte views, BigInt paths and decoder constructors", () => {
  const hex = unwrapNativeMetadata(eras.find((era) => era.spec === 470)!.v15)!;
  const before = new CountedPreviousReader(hex, NATIVE_RUNTIME_LIMITS.metadataBytes);
  const expected = serialized(decodeNativeMetadata(before));
  const Decoder = globalThis.TextDecoder;
  let constructions = 0;
  class CountedDecoder extends Decoder {
    constructor(...args: ConstructorParameters<typeof Decoder>) {
      super(...args);
      constructions++;
    }
  }
  vi.stubGlobal("TextDecoder", CountedDecoder);
  try {
    const after = new NativeScaleReader(hex, NATIVE_RUNTIME_LIMITS.metadataBytes);
    assert.equal(serialized(decodeNativeMetadata(after)), expected);
    assert.equal(constructions, 1);
  } finally {
    vi.unstubAllGlobals();
  }
  const decode = (previous: boolean) =>
    decodeNativeMetadata(new (previous ? PreviousReader : NativeScaleReader)(hex, NATIVE_RUNTIME_LIMITS.metadataBytes));
  for (let iteration = 0; iteration < 5; iteration++) {
    decode(true);
    decode(false);
  }
  const previous: number[] = [],
    current: number[] = [];
  for (let sample = 0; sample < 5; sample++)
    for (const old of sample % 2 ? [false, true] : [true, false]) {
      const start = performance.now();
      for (let iteration = 0; iteration < 5; iteration++) decode(old);
      (old ? previous : current).push((performance.now() - start) / 5);
    }
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[2]!;
  console.log(
    "NATIVE_READER_ALLOCATION_FIXTURE",
    JSON.stringify({
      spec: 470,
      single_byte_views_removed: before.byteReads,
      bigint_byte_paths_removed: before.byteReads,
      previous_text_decoder_constructors: before.textReads,
      text_decoder_constructors: constructions,
      retained_contract_bytes: Buffer.byteLength(expected),
      contract_bytes_equal: true,
      iterations_per_sample: 5,
      samples: 5,
      previous_median_ms: median(previous),
      direct_median_ms: median(current),
      fixture: true,
      production: false,
    }),
  );
});
