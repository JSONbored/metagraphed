import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { test, vi } from "vitest";
import eras from "./fixtures/native-runtime-eras-compiled.ts";
import legacy from "./fixtures/native-runtime-legacy-compiled.ts";
import {
  NativeScaleReader,
  NATIVE_RUNTIME_LIMITS,
  decodeNativeMetadata,
  unwrapNativeMetadata,
  unwrapNativeMetadataReader,
} from "../src/native-runtime-metadata.ts";

const previous = (hex: unknown) => {
  const bare = unwrapNativeMetadata(hex);
  return bare === null
    ? null
    : new NativeScaleReader(bare, NATIVE_RUNTIME_LIMITS.metadataBytes);
};
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

test("direct metadata views preserve all 180 compiled projections, bytes and checksums without hex serialization", () => {
  let cases = 0;
  for (const era of [...legacy, ...eras])
    for (const format of [14, 15] as const) {
      const old = previous(era[`v${format}`])!;
      const blob = vi
        .spyOn(NativeScaleReader.prototype, "blob")
        .mockImplementation(() => {
          throw new Error("Unexpected metadata hex copy");
        });
      let direct: NativeScaleReader;
      try {
        direct = unwrapNativeMetadataReader(era[`v${format}`])!;
        assert.equal(blob.mock.calls.length, 0);
      } finally {
        blob.mockRestore();
      }
      assert.equal(direct.offset, 0);
      assert.ok(direct.bytes.byteOffset > 0);
      assert.equal(direct.bytes.byteLength, old.bytes.byteLength);
      assert.equal(sha(direct.bytes), sha(old.bytes));
      assert.equal(
        Buffer.from(direct.bytes).toString("hex"),
        Buffer.from(old.bytes).toString("hex"),
      );
      const before = decodeNativeMetadata(old),
        after = decodeNativeMetadata(direct);
      const serialize = (model: typeof before) =>
        JSON.stringify({ ...model, types: [...model.types.values()] });
      assert.equal(serialize(after), serialize(before));
      cases++;
    }
  assert.equal(cases, 180);
});

test("wrapper option, canonical length, truncation, trailing bytes and payload limits match the hex path", () => {
  for (const input of [
    "0x00",
    "0x0100",
    "0x",
    "0x02",
    "0x0000",
    "0x010400",
    "0x010500",
    "0x01ff",
    "0x01",
    "0X00",
    "0xzz",
    null,
    [],
    42,
  ]) {
    function outcome(read: (value: unknown) => NativeScaleReader | null) {
      try {
        const value = read(input);
        return value === null
          ? { none: true }
          : {
              bytes: Buffer.from(value.bytes).toString("hex"),
              offset: value.offset,
            };
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    assert.deepEqual(outcome(unwrapNativeMetadataReader), outcome(previous));
  }
  const oversized = `0x${"00".repeat(NATIVE_RUNTIME_LIMITS.metadataBytes + 9)}`;
  assert.throws(
    () => previous(oversized),
    /Invalid or oversized native SCALE data/,
  );
  assert.throws(
    () => unwrapNativeMetadataReader(oversized),
    /Invalid or oversized native SCALE data/,
  );
  // Canonical compact length 2,097,153 exceeds the same payload budget before taking bytes.
  const length = Buffer.alloc(4);
  length.writeUInt32LE(((NATIVE_RUNTIME_LIMITS.metadataBytes + 1) << 2) | 2);
  const tooLong = `0x01${length.toString("hex")}`;
  assert.throws(() => previous(tooLong), /collection exceeds work budget/);
  assert.throws(
    () => unwrapNativeMetadataReader(tooLong),
    /collection exceeds work budget/,
  );
});

test("compiled v470 direct unwrapping removes full payload copies and the hex round trip", () => {
  const wrapped = eras.find((era) => era.spec === 470)!.v15;
  const before = previous(wrapped)!,
    after = unwrapNativeMetadataReader(wrapped)!;
  assert.equal(sha(before.bytes), sha(after.bytes));
  const iterations = 50,
    samples = 5,
    oldTimes: number[] = [],
    newTimes: number[] = [];
  const measure = (read: typeof previous) => {
    const start = performance.now();
    for (let i = 0; i < iterations; i++)
      assert.equal(read(wrapped)!.bytes.length, before.bytes.length);
    return (performance.now() - start) / iterations;
  };
  for (let i = 0; i < 5; i++) {
    previous(wrapped);
    unwrapNativeMetadataReader(wrapped);
  }
  for (let i = 0; i < samples; i++) {
    if (i % 2 === 0) {
      oldTimes.push(measure(previous));
      newTimes.push(measure(unwrapNativeMetadataReader));
    } else {
      newTimes.push(measure(unwrapNativeMetadataReader));
      oldTimes.push(measure(previous));
    }
  }
  const median = (rows: number[]) => [...rows].sort((a, b) => a - b)[2]!;
  console.log(
    "NATIVE_METADATA_VIEW_FIXTURE",
    JSON.stringify({
      spec: 470,
      metadata_bytes: before.bytes.length,
      payload_buffer_copies_removed: 2,
      copied_payload_bytes_removed: before.bytes.length * 2,
      intermediate_hex_characters_removed: before.bytes.length * 2 + 2,
      payload_hex_validations_removed: 1,
      checksum_equal: true,
      iterations_per_sample: iterations,
      samples,
      previous_median_ms: median(oldTimes),
      direct_median_ms: median(newTimes),
      fixture: true,
      production: false,
    }),
  );
});
