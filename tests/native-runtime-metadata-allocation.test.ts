import assert from "node:assert/strict";
import { test } from "vitest";
import eras from "./fixtures/native-runtime-eras-compiled.ts";
import legacy from "./fixtures/native-runtime-legacy-compiled.ts";
import {
  NativeScaleReader,
  NATIVE_RUNTIME_LIMITS,
  decodeNativeMetadata,
  unwrapNativeMetadata,
  type NativeMetadata,
} from "../src/native-runtime-metadata.ts";

class PreviousArrayReader extends NativeScaleReader {
  override forEach(
    read: () => void,
    limit: number = NATIVE_RUNTIME_LIMITS.items,
  ) {
    Array.from({ length: this.count(limit) }, read);
  }
}
class CountedReader extends NativeScaleReader {
  discardedArrays = 0;
  discardedElements = 0;
  override forEach(
    read: () => void,
    limit: number = NATIVE_RUNTIME_LIMITS.items,
  ) {
    this.discardedArrays++;
    super.forEach(() => {
      this.discardedElements++;
      read();
    }, limit);
  }
}
const serialized = (value: NativeMetadata) =>
  JSON.stringify({ ...value, types: [...value.types.values()] });

test("metadata traversal retains canonical lengths, work limits, text validation and callback errors", () => {
  const empty = new NativeScaleReader("0x00");
  let visited = 0;
  assert.equal(empty.forEach(() => visited++), undefined);
  assert.equal(empty.finish(visited), 0);
  const two = new NativeScaleReader("0x080102");
  const values: number[] = [];
  two.forEach(() => values.push(two.byte()), 2);
  assert.deepEqual(two.finish(values), [1, 2]);
  const bounded = new NativeScaleReader("0x080102");
  assert.throws(() => bounded.forEach(() => visited++, 1), /work budget/);
  assert.equal(visited, 0);
  assert.throws(
    () => new NativeScaleReader("0xfd00").forEach(() => visited++),
    /Noncanonical/,
  );
  const truncated = new NativeScaleReader("0x0801");
  assert.throws(() => truncated.forEach(() => truncated.byte()), /Truncated/);
  const invalidText = new NativeScaleReader("0x0404ff");
  assert.throws(() => invalidText.forEach(() => invalidText.text()));
  const text = new NativeScaleReader("0x0410efbbbf41");
  const strings: string[] = [];
  text.forEach(() => strings.push(text.text()));
  assert.deepEqual(text.finish(strings), ["\uFEFFA"]);
  const failure = new Error("fixture callback failure");
  assert.throws(
    () =>
      new NativeScaleReader("0x04").forEach(() => {
        throw failure;
      }),
    (error) => error === failure,
  );
});

test("discarded metadata arrays are removed across all compiled release contracts with byte-identical projections", () => {
  let contracts = 0;
  for (const era of [...legacy, ...eras])
    for (const version of [14, 15] as const) {
      const hex = unwrapNativeMetadata(era[`v${version}`])!;
      const oldReader = new PreviousArrayReader(
        hex,
        NATIVE_RUNTIME_LIMITS.metadataBytes,
      );
      const reader = new CountedReader(hex, NATIVE_RUNTIME_LIMITS.metadataBytes);
      const model = decodeNativeMetadata(reader);
      assert.equal(
        serialized(model),
        serialized(decodeNativeMetadata(oldReader)),
        `spec ${era.spec} V${version}`,
      );
      assert.ok(reader.discardedArrays > 0);
      assert.ok(reader.discardedElements >= model.types.size);
      contracts++;
    }
  assert.equal(contracts, 180);
}, 60000);

test("compiled v470 metadata fixture measures the removed allocations and preserves the complete contract", () => {
  const hex = unwrapNativeMetadata(eras.find((era) => era.spec === 470)!.v15)!;
  const reader = new CountedReader(hex, NATIVE_RUNTIME_LIMITS.metadataBytes);
  const result = serialized(decodeNativeMetadata(reader));
  const decode = (previous: boolean) =>
    decodeNativeMetadata(
      previous
        ? new PreviousArrayReader(hex, NATIVE_RUNTIME_LIMITS.metadataBytes)
        : new NativeScaleReader(hex, NATIVE_RUNTIME_LIMITS.metadataBytes),
    );
  assert.equal(serialized(decode(true)), result);
  for (let iteration = 0; iteration < 5; iteration++) {
    decode(true);
    decode(false);
  }
  const previous: number[] = [], current: number[] = [];
  for (let sample = 0; sample < 5; sample++) {
    // Alternate measurement order to avoid always warming one implementation.
    for (const old of sample % 2 ? [false, true] : [true, false]) {
      const start = performance.now();
      for (let iteration = 0; iteration < 5; iteration++) decode(old);
      (old ? previous : current).push((performance.now() - start) / 5);
    }
  }
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[2]!;
  console.log(
    "NATIVE_METADATA_DISCARDED_ARRAY_FIXTURE",
    JSON.stringify({
      spec: 470,
      discarded_arrays_removed: reader.discardedArrays,
      discarded_element_slots_removed: reader.discardedElements,
      retained_contract_bytes: Buffer.byteLength(result),
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
