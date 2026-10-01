import assert from "node:assert/strict";
import { test } from "vitest";
import { TypeRegistry } from "@polkadot/types/create";
import { Metadata } from "@polkadot/types/metadata";
import metadata14 from "./fixtures/native-metadata-v14.ts";
import metadata15 from "./fixtures/native-metadata-v15.ts";
import {
  NativeScaleReader,
  decodeNativeMetadata,
  unwrapNativeMetadata,
  type NativeMetadata,
  type NativeType,
  type NativeDefinition,
} from "../src/native-runtime-metadata.ts";
import {
  decodeNativeValue,
  encodeNativeValue,
  nativeStorageKey,
  nativeHex,
  nativeCompact,
  nativeStorageEntryKeys,
  type NativeValue,
} from "../src/native-runtime-values.ts";

function bare(value: string) {
  return value.startsWith("0x6d657461") ? value : unwrapNativeMetadata(value)!;
}
for (const [version, fixture] of [
  [14, metadata14],
  [15, metadata15],
] as const) {
  test(`portable metadata V${version} matches the independent pinned reference library`, () => {
    const hex = bare(fixture);
    const ours = decodeNativeMetadata(hex);
    const registry = new TypeRegistry();
    const reference = new Metadata(registry, hex);
    registry.setMetadata(reference);
    assert.equal(ours.version, version);
    assert.equal(ours.types.size, reference.asLatest.lookup.types.length);
    assert.deepEqual(
      ours.pallets.map((p) => [p.name, p.index]),
      reference.asLatest.pallets.map((p) => [
        p.name.toString(),
        p.index.toNumber(),
      ]),
    );
    for (const pallet of ours.pallets)
      for (const constant of pallet.constants) {
        const decoded = decodeNativeValue(ours, constant.type, constant.value);
        assert.equal(
          nativeHex(encodeNativeValue(ours, constant.type, decoded)),
          constant.value,
        );
      }
    const system = ours.pallets.find((p) => p.name === "System")!;
    const account = system.storage.find((s) => s.name === "Account")!;
    const key = nativeStorageKey(ours, system.prefix, account, [
      `0x${"01".repeat(32)}`,
    ]);
    assert.match(
      key,
      /^0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9/,
    );
    if (version === 15) assert.ok(ours.apis.some((api) => api.name === "Core"));
    else assert.deepEqual(ours.apis, []);
    assert.throws(() => decodeNativeMetadata(hex + "00"), /Trailing/);
    assert.throws(() => decodeNativeMetadata(hex.slice(0, -2)), /Truncated/);
  });
}

function model(): NativeMetadata {
  const types = new Map<number, NativeType>();
  for (let id = 0; id <= 14; id++)
    types.set(id, {
      id,
      path: [],
      definition: { kind: "primitive", primitive: id },
    });
  const definitions: [number, NativeDefinition][] = [
    [15, { kind: "composite", fields: [{ name: null, type: 6 }] }],
    [
      16,
      {
        kind: "composite",
        fields: [
          { name: "amount", type: 7 },
          { name: "enabled", type: 0 },
        ],
      },
    ],
    [17, { kind: "tuple", types: [6, 2] }],
    [
      18,
      {
        kind: "variant",
        variants: [
          { name: "None", index: 0, fields: [] },
          { name: "Some", index: 8, fields: [{ name: null, type: 6 }] },
        ],
      },
    ],
    [19, { kind: "sequence", type: 3 }],
    [20, { kind: "array", type: 3, length: 32 }],
    [21, { kind: "sequence", type: 6 }],
    [22, { kind: "array", type: 4, length: 2 }],
    [23, { kind: "compact", type: 15 }],
    [24, { kind: "bits", store: 3, order: 25 }],
    [25, { kind: "composite", fields: [] }],
    [
      26,
      {
        kind: "composite",
        fields: [
          { name: null, type: 6 },
          { name: null, type: 0 },
        ],
      },
    ],
    [27, { kind: "sequence", type: 27 }],
    [28, { kind: "compact", type: 0 }],
    [29, { kind: "bits", store: 7, order: 25 }],
    [30, { kind: "composite", fields: [{ name: null, type: 30 }] }],
    [31, { kind: "array", type: 0, length: 16_385 }],
    [32, { kind: "compact", type: 3 }],
  ];
  for (const [id, definition] of definitions)
    types.set(id, { id, path: [], definition });
  return {
    version: 15,
    types,
    pallets: [],
    apis: [],
    extrinsicVersion: 4,
    signedExtensions: [],
  };
}
test("metadata reuse cannot bypass the wire budget or consume an already advanced reader", () => {
  const reader = new NativeScaleReader(bare(metadata14), 2_097_152);
  reader.take(1);
  assert.throws(() => decodeNativeMetadata(reader), /metadata reader/);
  const oversized = new NativeScaleReader(
    `0x${"00".repeat(2_097_153)}`,
    2_097_153,
  );
  assert.throws(() => decodeNativeMetadata(oversized), /metadata reader/);
});
test("all portable value families retain exact values and canonical bytes", () => {
  const meta = model();
  const cases: [number, NativeValue][] = [
    [0, true],
    [0, false],
    [1, "🌐"],
    [2, "Native chain"],
    ...Array.from({ length: 12 }, (_, i): [number, string] => [
      i + 3,
      i < 6
        ? ((1n << BigInt([8, 16, 32, 64, 128, 256][i]!)) - 1n).toString()
        : (-1n << BigInt([7, 15, 31, 63, 127, 255][i - 6]!)).toString(),
    ]),
    [15, "9007199254740993"],
    [16, { amount: "340282366920938463463374607431768211455", enabled: true }],
    [17, ["9007199254740993", "α"]],
    [18, { variant: "None", fields: {} }],
    [18, { variant: "Some", fields: "9007199254740993" }],
    [19, "0x010203"],
    [20, `0x${"af".repeat(32)}`],
    [21, ["0", "9007199254740993"]],
    [22, ["1", "65535"]],
    [23, "18446744073709551615"],
    [24, { bit_length: 9, bytes_hex: "0x0101" }],
    [25, {}],
    [26, ["1", true]],
  ];
  for (const [id, value] of cases) {
    const bytes = encodeNativeValue(meta, id, value);
    assert.deepEqual(decodeNativeValue(meta, id, nativeHex(bytes)), value);
  }
  for (const value of [
    0n,
    63n,
    64n,
    16_383n,
    16_384n,
    1_073_741_823n,
    1_073_741_824n,
    (1n << 256n) - 1n,
  ]) {
    const reader = new NativeScaleReader(nativeHex(nativeCompact(value)));
    assert.equal(reader.finish(reader.compact()), value);
  }
  assert.equal(nativeHex(encodeNativeValue(meta, 3, 12)), "0x0c");
  assert.equal(nativeHex(encodeNativeValue(meta, 19, [1, 2, 3])), "0x0c010203");
  assert.deepEqual(decodeNativeValue(meta, 9, "0x01"), "1");
});

test("malformed, ambiguous, oversized and recursive values are rejected", () => {
  const meta = model();
  for (const [id, value] of [
    [3, Number.MAX_SAFE_INTEGER + 1],
    [3, "01"],
    [3, {}],
    [3, -1],
    [3, 256],
    [9, -129],
    [9, 128],
    [0, 1],
    [1, ""],
    [1, "ab"],
    [1, "\ud800"],
    [2, 1],
    [2, "\ud800"],
    [2, "\udfff"],
    [2, "a".repeat(65_537)],
    [16, { amount: "1" }],
    [16, { amount: "1", enabled: true, extra: 1 }],
    [16, null],
    [26, ["1"]],
    [17, {}],
    [17, ["1"]],
    [18, null],
    [18, { variant: "Other", fields: {} }],
    [18, { variant: "None" }],
    [19, {}],
    [19, Array(16_385).fill(1)],
    [20, "0x00"],
    [22, "0x0000"],
    [23, "18446744073709551616"],
    [23, -1],
    [28, "1"],
    [24, null],
    [24, { bit_length: -1, bytes_hex: "0x" }],
    [24, { bit_length: 1, bytes_hex: "0x" }],
    [29, { bit_length: 1, bytes_hex: "0x00" }],
    [30, "1"],
    [32, "256"],
    [21, Array(16_384).fill("1")],
    [2, "a".repeat(262_145)],
  ] as [number, NativeValue][])
    assert.throws(
      () => encodeNativeValue(meta, id, value),
      undefined,
      `${id}:${typeof value}`,
    );
  let recursive: NativeValue = [];
  for (let i = 0; i < 66; i++) recursive = [recursive];
  assert.throws(() => encodeNativeValue(meta, 27, recursive), /budget/);
  for (const [id, hex] of [
    [0, "0x02"],
    [1, "0x00d80000"],
    [1, "0x00001100"],
    [18, "0x02"],
    [32, "0x0104"],
    [29, "0x0400"],
    [31, "0x"],
    [30, "0x"],
  ] as const)
    assert.throws(() => decodeNativeValue(meta, id, hex));
  assert.throws(
    () => decodeNativeValue(meta, 27, `0x${"04".repeat(66)}00`),
    /budget/,
  );
  assert.throws(() => decodeNativeValue(meta, 999, "0x"), /Missing/);
  assert.throws(() => encodeNativeValue(meta, 999, 0), /Missing/);
  assert.throws(() => nativeCompact(-1n));
  assert.throws(() => nativeCompact(1n << 256n));
  for (const hex of [null, "0x0", "0xzz", "0x" + "00".repeat(262_145)])
    assert.throws(() => new NativeScaleReader(hex));
  assert.throws(() => new NativeScaleReader("0x").take(-1));
  assert.throws(() => new NativeScaleReader("0x").take(0.5));
  for (const hex of ["0x0100", "0x02000000", "0x0300000000", "0x7300"])
    assert.throws(() => new NativeScaleReader(hex).compact());
  assert.throws(() => new NativeScaleReader("0x0520").count(1));
  assert.throws(() => new NativeScaleReader("0x02").option(() => 0));
  assert.throws(() => new NativeScaleReader("0x04ff").text());
  assert.equal(unwrapNativeMetadata("0x00"), null);
  assert.throws(() => unwrapNativeMetadata("0x0000"), /Trailing/);
  assert.throws(() => decodeNativeMetadata("0x000000000e"), /magic/);
  assert.throws(() => decodeNativeMetadata("0x6d6574610d"), /format/);
});

test("all seven native storage hashers and multi-map keys use canonical SCALE inputs", () => {
  const meta = model();
  for (let hasher = 0; hasher <= 6; hasher++) {
    const item = {
      name: "Test",
      optional: false,
      value: 6,
      key: 4,
      hashers: [hasher],
      fallback: "0x",
    };
    const key = nativeStorageKey(meta, "SubtensorModule", item, [65535]);
    const decoded = nativeStorageEntryKeys(meta, "SubtensorModule", item, key);
    assert.deepEqual(decoded, [
      ...([2, 5, 6].includes(hasher)
        ? [{ value: "65535" }]
        : [{ hash: `0x${key.slice(66)}`, hasher }]),
    ]);
    assert.equal(
      (key.length - 2) / 2,
      32 + [16, 32, 18, 16, 32, 10, 2][hasher]!,
    );
    assert.equal(
      key,
      nativeStorageKey(meta, "SubtensorModule", item, ["65535"]),
    );
  }
  const plain = {
    name: "Value",
    optional: false,
    value: 6,
    key: null,
    hashers: [],
    fallback: "0x",
  };
  assert.equal(
    (nativeStorageKey(meta, "SubtensorModule", plain, []).length - 2) / 2,
    32,
  );
  const map = { ...plain, key: 17, hashers: [5, 6] };
  const mapKey = nativeStorageKey(meta, "SubtensorModule", map, ["1", "abc"]);
  assert.deepEqual(
    nativeStorageEntryKeys(meta, "SubtensorModule", map, mapKey),
    [{ value: "1" }, { value: "abc" }],
  );
  assert.throws(
    () => nativeStorageEntryKeys(meta, "P", plain, "0x00"),
    /storage map/,
  );
  assert.throws(() => nativeStorageEntryKeys(meta, "P", map, mapKey), /prefix/);
  assert.throws(
    () =>
      nativeStorageEntryKeys(
        meta,
        "SubtensorModule",
        { ...map, key: 4 },
        mapKey,
      ),
    /arity/,
  );
  assert.throws(
    () =>
      nativeStorageEntryKeys(
        meta,
        "SubtensorModule",
        { ...map, hashers: [7, 6] },
        mapKey,
      ),
    /hasher/,
  );
  assert.match(
    nativeStorageKey(meta, "SubtensorModule", map, ["1", "abc"]),
    /^0x/,
  );
  assert.throws(() => nativeStorageKey(meta, "P", plain, [1]), /arity/);
  assert.throws(
    () => nativeStorageKey(meta, "P", { ...map, key: 4 }, [1, 2]),
    /tuple/,
  );
  assert.throws(
    () => nativeStorageKey(meta, "P", { ...map, hashers: [1, 2, 3] }, [1, 2]),
    /arity/,
  );
  assert.throws(
    () => nativeStorageKey(meta, "P", { ...plain, key: 4, hashers: [7] }, [1]),
    /hasher/,
  );
});

test("portable metadata rejects malformed definitions and storage shapes at their actual wire boundary", () => {
  const wire = (bytes: number[]) =>
    nativeHex(Buffer.from([0x6d, 0x65, 0x74, 0x61, 15, ...bytes]));
  for (const [tail, message] of [
    [[4, 0, 0, 0, 5, 15], /primitive/],
    [[4, 0, 0, 0, 8], /definition/],
    [[8, 0, 0, 0, 5, 0, 0, 0, 0, 0, 5, 0, 0], /Duplicate/],
  ] as const)
    assert.throws(() => decodeNativeMetadata(wire([...tail])), message);
  // Empty lookup; one pallet P, a storage prefix P, and one member M.
  const storage = [0, 4, 4, 80, 1, 4, 80, 4, 4, 77];
  for (const [tail, message] of [
    [[2], /modifier/],
    [[1, 2], /storage type/],
    [[1, 1, 4, 7], /hasher/],
    [[1, 1, 0], /Empty/],
  ] as const)
    assert.throws(
      () => decodeNativeMetadata(wire([...storage, ...tail])),
      message,
    );
  assert.throws(() => new NativeScaleReader("0x77").compact(), /u256/);
});
test("reader budgets, recursive compact types and aggregate encoding limits cannot be bypassed", () => {
  const metadata = model();
  metadata.types.set(33, {
    id: 33,
    path: [],
    definition: { kind: "composite", fields: [{ name: null, type: 33 }] },
  });
  metadata.types.set(34, {
    id: 34,
    path: [],
    definition: { kind: "compact", type: 33 },
  });
  assert.throws(() => decodeNativeValue(metadata, 34, "0x04"), /recursion/);
  assert.throws(() => encodeNativeValue(metadata, 34, "1"), /recursion/);
  metadata.types.set(35, {
    id: 35,
    path: [],
    definition: { kind: "sequence", type: 8 },
  });
  assert.throws(
    () => encodeNativeValue(metadata, 35, Array(8193).fill("1")),
    /byte budget/,
  );
  assert.equal(decodeNativeValue(metadata, 9, "0x00"), "0");
  assert.equal(nativeHex(encodeNativeValue(metadata, 9, "1")), "0x01");
  const oversized = new NativeScaleReader(`0x${"00".repeat(262145)}`, 262145);
  assert.throws(
    () => decodeNativeValue(metadata, 3, oversized),
    /value reader/,
  );
  for (const offset of [-1, 0.5, 1]) {
    const reader = new NativeScaleReader("0x");
    reader.offset = offset;
    assert.throws(() => decodeNativeValue(metadata, 3, reader), /value reader/);
  }
});
