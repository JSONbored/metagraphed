import assert from "node:assert/strict";
import { test, vi, afterEach } from "vitest";
import { planNativeValuePage } from "../src/native-runtime-page.ts";
import {
  NativeScaleReader,
  type NativeMetadata,
  type NativeDefinition,
} from "../src/native-runtime-metadata.ts";
import {
  encodeNativeValue,
  nativeHex,
  nativeCompact,
  decodeNativeValue,
} from "../src/native-runtime-values.ts";
import type { NativeValue } from "../src/native-runtime-values.ts";

function model(extra: [number, NativeDefinition][] = []): NativeMetadata {
  const definitions: [number, NativeDefinition][] = [
    ...Array.from({ length: 15 }, (_, id): [number, NativeDefinition] => [
      id,
      { kind: "primitive", primitive: id },
    ]),
    [15, { kind: "sequence", type: 3 }],
    [16, { kind: "sequence", type: 6 }],
    [17, { kind: "array", type: 6, length: 3 }],
    [18, { kind: "tuple", types: [16] }],
    [19, { kind: "composite", fields: [{ name: null, type: 16 }] }],
    [20, { kind: "compact", type: 3 }],
    [21, { kind: "bits", store: 4, order: 22 }],
    [22, { kind: "composite", fields: [] }],
    [
      23,
      {
        kind: "variant",
        variants: [
          { name: "None", index: 0, fields: [] },
          { name: "Some", index: 1, fields: [{ name: null, type: 16 }] },
        ],
      },
    ],
    [24, { kind: "sequence", type: 16 }],
    [25, { kind: "array", type: 3, length: 4 }],
    [26, { kind: "tuple", types: [6, 16] }],
    [
      27,
      {
        kind: "composite",
        fields: [
          { name: null, type: 6 },
          { name: null, type: 16 },
        ],
      },
    ],
    [
      28,
      {
        kind: "composite",
        fields: [
          { name: "bool", type: 0 },
          { name: "char", type: 1 },
          { name: "text", type: 2 },
          { name: "enum", type: 23 },
          { name: "compact", type: 20 },
          { name: "bits", type: 21 },
          { name: "bytes", type: 25 },
          { name: "signed", type: 14 },
          { name: "array", type: 17 },
          { name: "empty", type: 22 },
          { name: "page", type: 16 },
        ],
      },
    ],
    ...extra,
  ];
  return {
    version: 15,
    types: new Map(
      definitions.map(([id, definition]) => [id, { id, path: [], definition }]),
    ),
    pallets: [],
    apis: [],
    extrinsicVersion: 4,
    signedExtensions: [],
  };
}
afterEach(() => vi.restoreAllMocks());
const values = ["0", "9007199254740993", "18446744073709551615"];
function page(
  model: NativeMetadata,
  root: number,
  value: NativeValue,
  path: (string | number)[] = [],
  offset = 1,
  limit = 1,
) {
  const hex = nativeHex(encodeNativeValue(model, root, value));
  return planNativeValuePage(model, root, { path, offset, limit }).decode(hex);
}

test("all portable collection and path shapes retain exact values and explicit continuation", () => {
  const m = model();
  for (const [id, value, path] of [
    [16, values, []],
    [17, values, []],
    [18, [values], [0]],
    [19, values, []],
    [23, { variant: "Some", fields: values }, ["Some"]],
    [24, [["1"], values], [1]],
    [26, ["4", values], [1]],
    [27, ["4", values], [1]],
  ] as [number, NativeValue, (string | number)[]][]) {
    const out = page(m, id, value, path);
    assert.deepEqual(out.value, [values[1]]);
    assert.equal(out.value_page.total, 3);
    assert.equal(out.value_page.next_offset, 2);
    assert.deepEqual(out.value_page.path, path);
    assert.equal(out.value_page.value_encoding, "items");
    assert.equal(page(m, id, value, path, 3).value_page.next_offset, null);
  }
  const named = model([
    [
      40,
      {
        kind: "variant",
        variants: [
          {
            name: "Rows",
            index: 3,
            fields: [
              { name: "count", type: 6 },
              { name: "rows", type: 16 },
            ],
          },
        ],
      },
    ],
  ]);
  assert.deepEqual(
    page(named, 40, { variant: "Rows", fields: { count: "3", rows: values } }, [
      "Rows",
      "rows",
    ]).value,
    [values[1]],
  );
  const positional = model([
    [
      40,
      {
        kind: "variant",
        variants: [
          {
            name: "Rows",
            index: 3,
            fields: [
              { name: null, type: 6 },
              { name: null, type: 16 },
            ],
          },
        ],
      },
    ],
  ]);
  assert.deepEqual(
    page(positional, 40, { variant: "Rows", fields: ["3", values] }, [
      "Rows",
      1,
    ]).value,
    [values[1]],
  );
  assert.equal(page(m, 15, "0x00010203").value, "0x01");
  assert.equal(page(m, 25, "0x00010203").value, "0x01");
  assert.equal(page(m, 15, "0x", [], 0).value, "0x");
  assert.deepEqual(page(m, 16, [], [], 0).value, []);
  const hex = nativeHex(encodeNativeValue(m, 16, values));
  const reader = new NativeScaleReader(hex + "00");
  assert.deepEqual(
    planNativeValuePage(m, 16, { path: [], offset: 0, limit: 1 }).decode(reader)
      .value,
    ["0"],
  );
  assert.equal(reader.offset, (hex.length - 2) / 2);
});

test("every omitted field is validated, including booleans, Unicode, variants, compacts and bits", () => {
  const m = model();
  const value = {
    bool: false,
    char: "A",
    text: "\ufefftext",
    enum: { variant: "Some", fields: values },
    compact: "255",
    bits: { bit_length: 3, bytes_hex: "0x0700" },
    bytes: "0x00010203",
    signed: "-9007199254740993",
    array: values,
    empty: {},
    page: values,
  };
  assert.deepEqual(page(m, 28, value, ["page"]).value, [values[1]]);
  assert.deepEqual(
    page(m, 28, { ...value, enum: { variant: "None", fields: {} } }, ["page"])
      .value,
    [values[1]],
  );
  for (const [id, bad] of [
    [0, "02"],
    [1, "00d80000"],
    [1, "00001100"],
    [2, "04ff"],
    [23, "ff"],
    [20, "0100"],
    [20, nativeHex(nativeCompact(256n)).slice(2)],
    [21, "04"],
  ] as const) {
    const layout = model([[40, { kind: "tuple", types: [id, 16] }]]);
    const hex = `0x${bad}${nativeHex(encodeNativeValue(layout, 16, values)).slice(2)}`;
    assert.throws(() =>
      planNativeValuePage(layout, 40, {
        path: [1],
        offset: 0,
        limit: 1,
      }).decode(hex),
    );
    const tail = model([[40, { kind: "tuple", types: [16, id] }]]);
    assert.throws(() =>
      planNativeValuePage(tail, 40, { path: [0], offset: 0, limit: 1 }).decode(
        nativeHex(encodeNativeValue(tail, 16, values)) + bad,
      ),
    );
  }
  const invalidBits = model([
    [41, { kind: "bits", store: 7, order: 22 }],
    [40, { kind: "tuple", types: [41, 16] }],
  ]);
  assert.throws(
    () =>
      planNativeValuePage(invalidBits, 40, {
        path: [1],
        offset: 0,
        limit: 1,
      }).decode("0x00"),
    /bit storage/,
  );
});

test("paging rejects absent paths and malformed complete payloads instead of returning partial success", () => {
  const m = model();
  for (const [id, path] of [
    [16, ["x"]],
    [17, [3]],
    [18, []],
    [18, [1]],
    [19, ["x"]],
    [23, ["Missing"]],
    [6, []],
  ] as [number, (string | number)[]][]) {
    assert.throws(
      () => planNativeValuePage(m, id, { path, offset: 0, limit: 1 }),
      /path/,
    );
  }
  assert.throws(
    () => planNativeValuePage(m, 999, { path: [], offset: 0, limit: 1 }),
    /Missing/,
  );
  assert.throws(() => page(m, 16, values, [], 4), /offset/);
  assert.throws(() => page(m, 24, [values], [1]), /index.*absent/);
  assert.throws(
    () => page(m, 23, { variant: "None", fields: {} }, ["Some"]),
    /variant/,
  );
  const plan = planNativeValuePage(m, 16, { path: [], offset: 0, limit: 1 });
  const hex = nativeHex(encodeNativeValue(m, 16, values));
  for (const malformed of [hex.slice(0, -2), hex + "00", "0x0100", "0x0540"])
    assert.throws(() => plan.decode(malformed));
  const array = model([
    [40, { kind: "array", type: 0, length: 16385 }],
    [41, { kind: "tuple", types: [16, 40] }],
  ]);
  assert.throws(
    () =>
      planNativeValuePage(array, 41, { path: [0], offset: 0, limit: 1 }).decode(
        nativeHex(encodeNativeValue(m, 16, [])),
      ),
    /budget/,
  );
  const recursive = model([
    [40, { kind: "composite", fields: [{ name: null, type: 40 }] }],
  ]);
  assert.throws(
    () => planNativeValuePage(recursive, 40, { path: [], offset: 0, limit: 1 }),
    /depth/,
  );
});

test("retained values share the ordinary allocation budget and omitted fixed values are never constructed", () => {
  const m = model([
    [40, { kind: "array", type: 6, length: 1000 }],
    [41, { kind: "sequence", type: 40 }],
  ]);
  const bytes = nativeHex(
    Buffer.concat([nativeCompact(17n), Buffer.alloc(17 * 1000 * 8)]),
  );
  assert.throws(
    () =>
      planNativeValuePage(m, 41, { path: [], offset: 0, limit: 17 }).decode(
        bytes,
      ),
    /work budget/,
  );
  assert.equal(
    (
      planNativeValuePage(m, 41, { path: [], offset: 0, limit: 1 }).decode(
        bytes,
      ).value as unknown[]
    ).length,
    1,
  );
  const tuple = model([
    [40, { kind: "sequence", type: 6 }],
    [41, { kind: "tuple", types: [40, 16] }],
  ]);
  const value = [Array(1000).fill("9007199254740993"), values];
  const hex = nativeHex(encodeNativeValue(tuple, 41, value));
  const uint = vi.spyOn(NativeScaleReader.prototype, "uint");
  const out = planNativeValuePage(tuple, 41, {
    path: [1],
    offset: 0,
    limit: 1,
  }).decode(hex);
  assert.deepEqual(out.value, ["0"]);
  assert.ok(uint.mock.calls.length < 5);
  uint.mockRestore();
  assert.deepEqual(decodeNativeValue(tuple, 41, hex), value);
});

test("zero-width wrappers and cached deep fixed layouts cannot bypass traversal/depth bounds", () => {
  const extra: [number, NativeDefinition][] = [];
  let child = 0;
  for (let id = 50; id < 110; id++) {
    extra.push([
      id,
      {
        kind: "composite",
        fields: [
          { name: "empty", type: 22 },
          { name: "next", type: child },
        ],
      },
    ]);
    child = id;
  }
  extra.push(
    [110, { kind: "sequence", type: child }],
    [111, { kind: "tuple", types: [110, 16] }],
  );
  const m = model(extra);
  const bytes = nativeHex(
    Buffer.concat([
      nativeCompact(10000n),
      Buffer.alloc(10000, 1),
      Buffer.from([0]),
    ]),
  );
  assert.throws(
    () =>
      planNativeValuePage(m, 111, { path: [1], offset: 0, limit: 1 }).decode(
        bytes,
      ),
    /validation.*budget/,
  );
  const deep: [number, NativeDefinition][] = [];
  let fixed = 6;
  for (let id = 50; id < 120; id++) {
    deep.push([
      id,
      { kind: "composite", fields: [{ name: null, type: fixed }] },
    ]);
    fixed = id;
  }
  deep.push([121, { kind: "tuple", types: [55, fixed, 16] }]);
  assert.throws(
    () =>
      planNativeValuePage(model(deep), 121, {
        path: [2],
        offset: 0,
        limit: 1,
      }).decode("0x0000000000000000"),
    /depth/,
  );
});
