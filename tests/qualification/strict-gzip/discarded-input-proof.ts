// Pure source/config association only. Full pg/output/map proof must still finish.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { types } from "node:util";
import {
  DISCARDED_INPUT_RECORD_PINS,
  DISCARDED_INPUT_SOURCE_PINS,
  ERASURE_CONFIG_SOURCE_PINS,
} from "./discarded-input-pins.ts";
export {
  DISCARDED_INPUT_RECORD_PINS,
  DISCARDED_INPUT_SOURCE_PINS,
  ERASURE_CONFIG_SOURCE_PINS,
};
export const DISCARDED_INPUT_LIMITS = Object.freeze({
  inputRecords: 8192,
  outputRecords: 1024,
  importsPerScope: 65536,
  sourceBytes: 2 * 1024 * 1024,
  totalSourceBytes: 2 * 1024 * 1024,
  configBytes: 1024 * 1024,
  totalConfigBytes: 1024 * 1024,
  targetCharacters: 4096,
  targetCharactersPerScope: 16 * 1024 * 1024,
});
export interface PendingDiscardedInput {
  actual: string;
  importIndex: number;
}
export interface DiscardedInputSource {
  actual: string;
  sha256: string;
  bytes: number;
}
export type ErasureConfigSources = Readonly<
  Record<keyof typeof ERASURE_CONFIG_SOURCE_PINS, Uint8Array>
>;
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const blob = (bytes: Uint8Array) =>
  createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");
function object(value: unknown): Record<string, unknown> {
  assert.ok(
    typeof value === "object" &&
      value !== null &&
      !types.isProxy(value) &&
      !Array.isArray(value),
    "Expected proof data object",
  );
  const prototype = Object.getPrototypeOf(value);
  assert.ok(
    prototype === Object.prototype || prototype === null,
    "Unexpected proof object prototype",
  );
  return value as Record<string, unknown>;
}
function property(value: unknown, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object(value), key);
  if (!descriptor) return undefined;
  assert.ok(Object.hasOwn(descriptor, "value"), "Proof accessor forbidden");
  return descriptor.value;
}
function keys(value: unknown, maximum: number): string[] {
  const receiver = object(value);
  const names = Reflect.ownKeys(receiver);
  assert.ok(names.length <= maximum, "Proof inventory budget exceeded");
  return names.map((name) => {
    assert.equal(typeof name, "string");
    const descriptor = Object.getOwnPropertyDescriptor(receiver, name)!;
    assert.ok(
      descriptor.enumerable && Object.hasOwn(descriptor, "value"),
      "Hidden/accessor proof entry",
    );
    return name as string;
  });
}
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteLength",
)!.get!;
const arrayBuffer = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "buffer",
)!.get!;
function boundedBytes(value: unknown, maximum: number): Uint8Array {
  assert.ok(
    !types.isProxy(value) && types.isUint8Array(value),
    "Expected inert proof bytes",
  );
  const length = byteLength.call(value) as number;
  assert.ok(length > 0 && length <= maximum, "Proof byte budget exceeded");
  assert.ok(
    !types.isSharedArrayBuffer(arrayBuffer.call(value)),
    "Shared proof bytes forbidden",
  );
  const copy = new Uint8Array(length);
  Uint8Array.prototype.set.call(copy, value as Uint8Array);
  return copy;
}
function verifyBytes(
  value: unknown,
  pin: { gitBlob: string; sha256: string; bytes: number },
  maximum: number,
): number {
  const bytes = boundedBytes(value, maximum);
  assert.equal(bytes.length, pin.bytes, "Pinned proof byte count changed");
  assert.equal(sha256(bytes), pin.sha256, "Pinned proof source changed");
  assert.equal(blob(bytes), pin.gitBlob, "Pinned proof Git blob changed");
  return bytes.length;
}
/** Recognition queues evidence only. It is never an import admission result. */
export function isReviewedDiscardedInputTuple(
  logical: string,
  index: number,
  value: unknown,
): boolean {
  const pin = DISCARDED_INPUT_RECORD_PINS.find(
    (row) => row.sourcePath === logical && row.importIndex === index,
  );
  if (!pin) return false;
  return (
    property(value, "path") === pin.target &&
    property(value, "kind") === pin.kind &&
    property(value, "external") === true &&
    property(value, "original") === undefined
  );
}
export function assertNoDiscardedInputEvidence(evidence: unknown): void {
  for (const name of ["discardedInputSources", "erasureConfigSources"]) {
    const value = property(evidence, name);
    assert.ok(
      value === undefined || keys(value, 0).length === 0,
      "Unexpected discarded-input evidence",
    );
  }
}
export function assertErasureConfigSources(evidence: unknown): void {
  const supplied = property(evidence, "erasureConfigSources");
  const names = Object.keys(
    ERASURE_CONFIG_SOURCE_PINS,
  ) as (keyof typeof ERASURE_CONFIG_SOURCE_PINS)[];
  assert.deepEqual(
    keys(supplied, names.length).sort(),
    [...names].sort(),
    "Missing erasure configuration custody",
  );
  let bytes = 0;
  for (const name of names)
    bytes += verifyBytes(
      property(supplied, name),
      ERASURE_CONFIG_SOURCE_PINS[name],
      DISCARDED_INPUT_LIMITS.configBytes,
    );
  assert.ok(
    bytes <= DISCARDED_INPUT_LIMITS.totalConfigBytes,
    "Whole-config byte budget exceeded",
  );
}
function imports(value: unknown): unknown[] {
  assert.ok(
    !types.isProxy(value) && Array.isArray(value),
    "Missing complete import inventory",
  );
  return value as unknown[];
}
function arrayItem(value: unknown[], index: number): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
  assert.ok(
    descriptor && Object.hasOwn(descriptor, "value"),
    "Sparse/accessor import record",
  );
  return descriptor.value;
}
function verifyExactMetadataBatch(
  meta: unknown,
  actualInputs: ReadonlyMap<string, string>,
) {
  assert.ok(
    !types.isProxy(actualInputs) && types.isMap(actualInputs),
    "Expected canonical input map",
  );
  actualInputs = new Map(
    Map.prototype.entries.call(actualInputs) as Iterable<[string, string]>,
  );
  assert.ok(
    actualInputs.size <= DISCARDED_INPUT_LIMITS.inputRecords,
    "Input identity budget exceeded",
  );
  const actualValues = [...actualInputs.values()];
  assert.ok(
    actualValues.every(
      (value) =>
        typeof value === "string" && value.length > 0 && value.length <= 4096,
    ),
    "Malformed canonical input key",
  );
  assert.equal(
    new Set(actualValues).size,
    actualValues.length,
    "Duplicate canonical input key",
  );
  const inputs = property(meta, "inputs");
  const outputs = property(meta, "outputs");
  const sourceNames = Object.keys(
    DISCARDED_INPUT_SOURCE_PINS,
  ) as (keyof typeof DISCARDED_INPUT_SOURCE_PINS)[];
  const actualNames = sourceNames.map((name) => {
    const actual = actualInputs.get(name);
    assert.ok(actual, "Reviewed importer absent");
    return actual;
  });
  assert.equal(
    new Set(actualNames).size,
    sourceNames.length,
    "Duplicate importer identity",
  );
  const expected = new Map(
    DISCARDED_INPUT_RECORD_PINS.map((pin) => [
      `${actualInputs.get(pin.sourcePath)}\0${pin.importIndex}`,
      pin,
    ]),
  );
  const allTargets = new Set<string>(
    DISCARDED_INPUT_RECORD_PINS.map((pin) => pin.target),
  );
  const seen = new Set<string>();
  for (const scope of ["inputs", "outputs"] as const) {
    const table = scope === "inputs" ? inputs : outputs;
    const names = keys(
      table,
      scope === "inputs"
        ? DISCARDED_INPUT_LIMITS.inputRecords
        : DISCARDED_INPUT_LIMITS.outputRecords,
    );
    let total = 0,
      characters = 0;
    for (const name of names) {
      const entry = property(table, name);
      const bytes = property(entry, "bytes");
      assert.ok(
        typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes >= 0,
        "Malformed metadata byte count",
      );
      const logical = sourceNames.find(
        (source) => actualInputs.get(source) === name,
      );
      if (scope === "inputs" && logical)
        assert.equal(
          bytes,
          DISCARDED_INPUT_SOURCE_PINS[logical].bytes,
          "Reviewed importer byte count changed",
        );
      const rows = imports(property(entry, "imports"));
      assert.ok(
        rows.length <= DISCARDED_INPUT_LIMITS.importsPerScope - total,
        "Whole-scope import budget exceeded",
      );
      for (let index = 0; index < rows.length; index++) {
        const row = arrayItem(rows, index);
        const target = property(row, "path"),
          kind = property(row, "kind"),
          external = property(row, "external");
        assert.ok(
          typeof target === "string" &&
            target.length > 0 &&
            target.length <= DISCARDED_INPUT_LIMITS.targetCharacters,
          "Malformed import path",
        );
        assert.ok(
          typeof kind === "string" && kind.length > 0 && kind.length <= 64,
          "Malformed import kind",
        );
        assert.ok(
          external === undefined || external === false || external === true,
          "Malformed external flag",
        );
        total++;
        characters += target.length;
        assert.ok(
          characters <= DISCARDED_INPUT_LIMITS.targetCharactersPerScope,
          "Whole-scope target budget exceeded",
        );
        if (scope === "outputs") {
          assert.ok(
            !allTargets.has(target),
            "Discarded target is present in an output import",
          );
        } else if (
          external === true &&
          target !== "pg-native" &&
          !/^(?:node:|cloudflare:)/.test(target)
        ) {
          const key = `${name}\0${index}`,
            pin = expected.get(key);
          assert.ok(
            pin && isReviewedDiscardedInputTuple(pin.sourcePath, index, row),
            "Unreviewed discarded record",
          );
          assert.ok(!seen.has(key), "Duplicate discarded record");
          seen.add(key);
        }
      }
    }
  }
  assert.deepEqual(
    [...seen].sort(),
    [...expected.keys()].sort(),
    "Missing exact discarded records",
  );
  return { actualInputs, sourceNames, actualNames, expected };
}
export interface DiscardedInputReadPlan {
  sources: { logical: string; actual: string }[];
  configs: (keyof typeof ERASURE_CONFIG_SOURCE_PINS)[];
}
/** Bounded read selection only. actualInputs comes from canonical owner identity checks. */
export function planDiscardedInputReads(
  metafile: unknown,
  actualInputs: ReadonlyMap<string, string>,
): DiscardedInputReadPlan | null {
  try {
    const verified = verifyExactMetadataBatch(metafile, actualInputs);
    return {
      sources: verified.sourceNames.map((logical) => ({
        logical,
        actual: verified.actualInputs.get(logical)!,
      })),
      configs: Object.keys(
        ERASURE_CONFIG_SOURCE_PINS,
      ) as (keyof typeof ERASURE_CONFIG_SOURCE_PINS)[],
    };
  } catch {
    return null;
  }
}
/** Validates one fixed batch; callers must still finish the entire existing proof. */
export function proveDiscardedInputBatch(
  evidence: unknown,
  actualInputs: ReadonlyMap<string, string>,
  pending: readonly PendingDiscardedInput[],
): ReadonlyMap<string, DiscardedInputSource> {
  assert.equal(
    pending.length,
    DISCARDED_INPUT_RECORD_PINS.length,
    "Incomplete discarded-input batch",
  );
  const { sourceNames, actualNames, expected } = verifyExactMetadataBatch(
    property(evidence, "metafile"),
    actualInputs,
  );
  const pendingKeys = pending.map((row) => `${row.actual}\0${row.importIndex}`);
  assert.equal(
    new Set(pendingKeys).size,
    pending.length,
    "Duplicate discarded record",
  );
  assert.deepEqual(
    [...pendingKeys].sort(),
    [...expected.keys()].sort(),
    "Discarded record inventory changed",
  );
  const inputs = property(property(evidence, "metafile"), "inputs");
  const supplied = property(evidence, "discardedInputSources");
  assert.deepEqual(
    keys(supplied, sourceNames.length).sort(),
    [...actualNames].sort(),
    "Missing discarded source custody",
  );
  const proved = new Map<string, DiscardedInputSource>();
  let totalBytes = 0;
  for (const name of sourceNames) {
    const actual = actualInputs.get(name)!;
    const pin = DISCARDED_INPUT_SOURCE_PINS[name];
    totalBytes += verifyBytes(
      property(supplied, actual),
      pin,
      DISCARDED_INPUT_LIMITS.sourceBytes,
    );
    assert.equal(
      property(property(inputs, actual), "bytes"),
      pin.bytes,
      "Importer metadata byte count changed",
    );
    proved.set(
      name,
      Object.freeze({ actual, sha256: pin.sha256, bytes: pin.bytes }),
    );
  }
  assert.ok(
    totalBytes <= DISCARDED_INPUT_LIMITS.totalSourceBytes,
    "Whole-source byte budget exceeded",
  );
  return proved;
}
