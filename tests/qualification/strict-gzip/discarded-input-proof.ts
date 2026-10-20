import {
  ownerProofFailure,
  withOwnerProofReason,
} from "./owner-proof-reasons.ts";
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
  withOwnerProofReason("discarded-operation-sha256", () =>
    createHash("sha256").update(bytes).digest("hex"),
  );
const blob = (bytes: Uint8Array) =>
  withOwnerProofReason("discarded-operation-blob", () =>
    createHash("sha1")
      .update(`blob ${bytes.byteLength}\0`)
      .update(bytes)
      .digest("hex"),
  );
function object(value: unknown): Record<string, unknown> {
  try {
    try {
      assert.ok(
        typeof value === "object" &&
          value !== null &&
          !types.isProxy(value) &&
          !Array.isArray(value),
        "Expected proof data object",
      );
    } catch (cause) {
      throw ownerProofFailure(cause, "discarded-001");
    }
    const prototype = Object.getPrototypeOf(value);
    try {
      assert.ok(
        prototype === Object.prototype || prototype === null,
        "Unexpected proof object prototype",
      );
    } catch (cause) {
      throw ownerProofFailure(cause, "discarded-002");
    }
    return value as Record<string, unknown>;
  } catch (cause) {
    throw ownerProofFailure(cause, "discarded-operation-object");
  }
}
function property(value: unknown, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(object(value), key);
    if (!descriptor) return undefined;
    try {
      assert.ok(Object.hasOwn(descriptor, "value"), "Proof accessor forbidden");
    } catch (cause) {
      throw ownerProofFailure(cause, "discarded-003");
    }
    return descriptor.value;
  } catch (cause) {
    throw ownerProofFailure(cause, "discarded-operation-property");
  }
}
function keys(value: unknown, maximum: number): string[] {
  try {
    const receiver = object(value);
    const names = Reflect.ownKeys(receiver);
    try {
      assert.ok(names.length <= maximum, "Proof inventory budget exceeded");
    } catch (cause) {
      throw ownerProofFailure(cause, "discarded-004");
    }
    return names.map((name) => {
      try {
        assert.equal(typeof name, "string");
      } catch (cause) {
        throw ownerProofFailure(cause, "discarded-005");
      }
      const descriptor = Object.getOwnPropertyDescriptor(receiver, name)!;
      try {
        assert.ok(
          descriptor.enumerable && Object.hasOwn(descriptor, "value"),
          "Hidden/accessor proof entry",
        );
      } catch (cause) {
        throw ownerProofFailure(cause, "discarded-006");
      }
      return name as string;
    });
  } catch (cause) {
    throw ownerProofFailure(cause, "discarded-operation-keys");
  }
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
  try {
    try {
      assert.ok(
        !types.isProxy(value) && types.isUint8Array(value),
        "Expected inert proof bytes",
      );
    } catch (cause) {
      throw ownerProofFailure(cause, "discarded-007");
    }
    const length = byteLength.call(value) as number;
    try {
      assert.ok(length > 0 && length <= maximum, "Proof byte budget exceeded");
    } catch (cause) {
      throw ownerProofFailure(cause, "discarded-008");
    }
    try {
      assert.ok(
        !types.isSharedArrayBuffer(arrayBuffer.call(value)),
        "Shared proof bytes forbidden",
      );
    } catch (cause) {
      throw ownerProofFailure(cause, "discarded-009");
    }
    const copy = new Uint8Array(length);
    Uint8Array.prototype.set.call(copy, value as Uint8Array);
    return copy;
  } catch (cause) {
    throw ownerProofFailure(cause, "discarded-operation-bounded-bytes");
  }
}
function verifyBytes(
  value: unknown,
  pin: { gitBlob: string; sha256: string; bytes: number },
  maximum: number,
): number {
  try {
    const bytes = boundedBytes(value, maximum);
    try {
      assert.equal(bytes.length, pin.bytes, "Pinned proof byte count changed");
    } catch (cause) {
      throw ownerProofFailure(cause, "discarded-010");
    }
    try {
      assert.equal(sha256(bytes), pin.sha256, "Pinned proof source changed");
    } catch (cause) {
      throw ownerProofFailure(cause, "discarded-011");
    }
    try {
      assert.equal(blob(bytes), pin.gitBlob, "Pinned proof Git blob changed");
    } catch (cause) {
      throw ownerProofFailure(cause, "discarded-012");
    }
    return bytes.length;
  } catch (cause) {
    throw ownerProofFailure(cause, "discarded-operation-verify-bytes");
  }
}
/** Recognition queues evidence only. It is never an import admission result. */
export function isReviewedDiscardedInputTuple(
  logical: string,
  index: number,
  value: unknown,
): boolean {
  try {
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
  } catch (cause) {
    throw ownerProofFailure(
      cause,
      "discarded-operation-is-reviewed-discarded-input-tuple",
    );
  }
}
export function assertNoDiscardedInputEvidence(evidence: unknown): void {
  try {
    for (const name of ["discardedInputSources", "erasureConfigSources"]) {
      const value = property(evidence, name);
      try {
        assert.ok(
          value === undefined || keys(value, 0).length === 0,
          "Unexpected discarded-input evidence",
        );
      } catch (cause) {
        throw ownerProofFailure(cause, "discarded-013");
      }
    }
  } catch (cause) {
    throw ownerProofFailure(
      cause,
      "discarded-operation-assert-no-discarded-input-evidence",
    );
  }
}
export function assertErasureConfigSources(evidence: unknown): void {
  try {
    const supplied = property(evidence, "erasureConfigSources");
    const names = Object.keys(
      ERASURE_CONFIG_SOURCE_PINS,
    ) as (keyof typeof ERASURE_CONFIG_SOURCE_PINS)[];
    try {
      assert.deepEqual(
        keys(supplied, names.length).sort(),
        [...names].sort(),
        "Missing erasure configuration custody",
      );
    } catch (cause) {
      throw ownerProofFailure(cause, "discarded-014");
    }
    let bytes = 0;
    for (const name of names)
      bytes += verifyBytes(
        property(supplied, name),
        ERASURE_CONFIG_SOURCE_PINS[name],
        DISCARDED_INPUT_LIMITS.configBytes,
      );
    try {
      assert.ok(
        bytes <= DISCARDED_INPUT_LIMITS.totalConfigBytes,
        "Whole-config byte budget exceeded",
      );
    } catch (cause) {
      throw ownerProofFailure(cause, "discarded-015");
    }
  } catch (cause) {
    throw ownerProofFailure(
      cause,
      "discarded-operation-assert-erasure-config-sources",
    );
  }
}
function imports(value: unknown): unknown[] {
  try {
    try {
      assert.ok(
        !types.isProxy(value) && Array.isArray(value),
        "Missing complete import inventory",
      );
    } catch (cause) {
      throw ownerProofFailure(cause, "discarded-016");
    }
    return value as unknown[];
  } catch (cause) {
    throw ownerProofFailure(cause, "discarded-operation-imports");
  }
}
function arrayItem(value: unknown[], index: number): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    try {
      assert.ok(
        descriptor && Object.hasOwn(descriptor, "value"),
        "Sparse/accessor import record",
      );
    } catch (cause) {
      throw ownerProofFailure(cause, "discarded-017");
    }
    return descriptor.value;
  } catch (cause) {
    throw ownerProofFailure(cause, "discarded-operation-array-item");
  }
}
function verifyExactMetadataBatch(
  meta: unknown,
  actualInputs: ReadonlyMap<string, string>,
) {
  try {
    try {
      assert.ok(
        !types.isProxy(actualInputs) && types.isMap(actualInputs),
        "Expected canonical input map",
      );
    } catch (cause) {
      throw ownerProofFailure(cause, "discarded-018");
    }
    actualInputs = new Map(
      Map.prototype.entries.call(actualInputs) as Iterable<[string, string]>,
    );
    try {
      assert.ok(
        actualInputs.size <= DISCARDED_INPUT_LIMITS.inputRecords,
        "Input identity budget exceeded",
      );
    } catch (cause) {
      throw ownerProofFailure(cause, "discarded-019");
    }
    const actualValues = [...actualInputs.values()];
    try {
      assert.ok(
        actualValues.every(
          (value) =>
            typeof value === "string" &&
            value.length > 0 &&
            value.length <= 4096,
        ),
        "Malformed canonical input key",
      );
    } catch (cause) {
      throw ownerProofFailure(cause, "discarded-020");
    }
    try {
      assert.equal(
        new Set(actualValues).size,
        actualValues.length,
        "Duplicate canonical input key",
      );
    } catch (cause) {
      throw ownerProofFailure(cause, "discarded-021");
    }
    const inputs = property(meta, "inputs");
    const outputs = property(meta, "outputs");
    const sourceNames = Object.keys(
      DISCARDED_INPUT_SOURCE_PINS,
    ) as (keyof typeof DISCARDED_INPUT_SOURCE_PINS)[];
    const actualNames = sourceNames.map((name) => {
      const actual = actualInputs.get(name);
      try {
        assert.ok(actual, "Reviewed importer absent");
      } catch (cause) {
        throw ownerProofFailure(cause, "discarded-022");
      }
      return actual;
    });
    try {
      assert.equal(
        new Set(actualNames).size,
        sourceNames.length,
        "Duplicate importer identity",
      );
    } catch (cause) {
      throw ownerProofFailure(cause, "discarded-023");
    }
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
        try {
          assert.ok(
            typeof bytes === "number" &&
              Number.isSafeInteger(bytes) &&
              bytes >= 0,
            "Malformed metadata byte count",
          );
        } catch (cause) {
          throw ownerProofFailure(cause, "discarded-024");
        }
        const logical = sourceNames.find(
          (source) => actualInputs.get(source) === name,
        );
        if (scope === "inputs" && logical)
          try {
            assert.equal(
              bytes,
              DISCARDED_INPUT_SOURCE_PINS[logical].bytes,
              "Reviewed importer byte count changed",
            );
          } catch (cause) {
            throw ownerProofFailure(cause, "discarded-025");
          }
        const rows = imports(property(entry, "imports"));
        try {
          assert.ok(
            rows.length <= DISCARDED_INPUT_LIMITS.importsPerScope - total,
            "Whole-scope import budget exceeded",
          );
        } catch (cause) {
          throw ownerProofFailure(cause, "discarded-026");
        }
        for (let index = 0; index < rows.length; index++) {
          const row = arrayItem(rows, index);
          const target = property(row, "path"),
            kind = property(row, "kind"),
            external = property(row, "external");
          try {
            assert.ok(
              typeof target === "string" &&
                target.length > 0 &&
                target.length <= DISCARDED_INPUT_LIMITS.targetCharacters,
              "Malformed import path",
            );
          } catch (cause) {
            throw ownerProofFailure(cause, "discarded-027");
          }
          try {
            assert.ok(
              typeof kind === "string" && kind.length > 0 && kind.length <= 64,
              "Malformed import kind",
            );
          } catch (cause) {
            throw ownerProofFailure(cause, "discarded-028");
          }
          try {
            assert.ok(
              external === undefined || external === false || external === true,
              "Malformed external flag",
            );
          } catch (cause) {
            throw ownerProofFailure(cause, "discarded-029");
          }
          total++;
          characters += target.length;
          try {
            assert.ok(
              characters <= DISCARDED_INPUT_LIMITS.targetCharactersPerScope,
              "Whole-scope target budget exceeded",
            );
          } catch (cause) {
            throw ownerProofFailure(cause, "discarded-030");
          }
          if (scope === "outputs") {
            try {
              assert.ok(
                !allTargets.has(target),
                "Discarded target is present in an output import",
              );
            } catch (cause) {
              throw ownerProofFailure(cause, "discarded-031");
            }
          } else if (
            external === true &&
            target !== "pg-native" &&
            !/^(?:node:|cloudflare:)/.test(target)
          ) {
            const key = `${name}\0${index}`,
              pin = expected.get(key);
            try {
              assert.ok(
                pin &&
                  isReviewedDiscardedInputTuple(pin.sourcePath, index, row),
                "Unreviewed discarded record",
              );
            } catch (cause) {
              throw ownerProofFailure(cause, "discarded-032");
            }
            try {
              assert.ok(!seen.has(key), "Duplicate discarded record");
            } catch (cause) {
              throw ownerProofFailure(cause, "discarded-033");
            }
            seen.add(key);
          }
        }
      }
    }
    try {
      assert.deepEqual(
        [...seen].sort(),
        [...expected.keys()].sort(),
        "Missing exact discarded records",
      );
    } catch (cause) {
      throw ownerProofFailure(cause, "discarded-034");
    }
    return { actualInputs, sourceNames, actualNames, expected };
  } catch (cause) {
    throw ownerProofFailure(
      cause,
      "discarded-operation-verify-exact-metadata-batch",
    );
  }
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
  try {
    try {
      assert.equal(
        pending.length,
        DISCARDED_INPUT_RECORD_PINS.length,
        "Incomplete discarded-input batch",
      );
    } catch (cause) {
      throw ownerProofFailure(cause, "discarded-035");
    }
    const { sourceNames, actualNames, expected } = verifyExactMetadataBatch(
      property(evidence, "metafile"),
      actualInputs,
    );
    const pendingKeys = pending.map(
      (row) => `${row.actual}\0${row.importIndex}`,
    );
    try {
      assert.equal(
        new Set(pendingKeys).size,
        pending.length,
        "Duplicate discarded record",
      );
    } catch (cause) {
      throw ownerProofFailure(cause, "discarded-036");
    }
    try {
      assert.deepEqual(
        [...pendingKeys].sort(),
        [...expected.keys()].sort(),
        "Discarded record inventory changed",
      );
    } catch (cause) {
      throw ownerProofFailure(cause, "discarded-037");
    }
    const inputs = property(property(evidence, "metafile"), "inputs");
    const supplied = property(evidence, "discardedInputSources");
    try {
      assert.deepEqual(
        keys(supplied, sourceNames.length).sort(),
        [...actualNames].sort(),
        "Missing discarded source custody",
      );
    } catch (cause) {
      throw ownerProofFailure(cause, "discarded-038");
    }
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
      try {
        assert.equal(
          property(property(inputs, actual), "bytes"),
          pin.bytes,
          "Importer metadata byte count changed",
        );
      } catch (cause) {
        throw ownerProofFailure(cause, "discarded-039");
      }
      proved.set(
        name,
        Object.freeze({ actual, sha256: pin.sha256, bytes: pin.bytes }),
      );
    }
    try {
      assert.ok(
        totalBytes <= DISCARDED_INPUT_LIMITS.totalSourceBytes,
        "Whole-source byte budget exceeded",
      );
    } catch (cause) {
      throw ownerProofFailure(cause, "discarded-040");
    }
    return proved;
  } catch (cause) {
    throw ownerProofFailure(
      cause,
      "discarded-operation-prove-discarded-input-batch",
    );
  }
}
