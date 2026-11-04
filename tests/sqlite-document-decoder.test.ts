import { DatabaseSync } from "node:sqlite";
import { afterAll, expect, test, vi } from "vitest";
import {
  createSqliteDocumentDecoder,
  readSqliteValue,
  SQLITE_DOCUMENT_DECODER,
  storeSqliteValue,
} from "../src/sqlite-document-decoder.ts";

const source = new DatabaseSync(":memory:");
const decoder = createSqliteDocumentDecoder({ maxAuditBytes: 2 * 1024 * 1024 });
const blob = (text: string) =>
  source.prepare("SELECT jsonb(?) AS value").get(text)!.value as Uint8Array;
afterAll(() => {
  decoder.close();
  source.close();
});

test("decodes the pinned binary format without normalizing duplicate keys", () => {
  const json =
    '{"1":{"axon":"first"},"1":{"axon":"last"},"n":9007199254740993}';
  const payload = blob(json);
  expect(decoder.identity).toEqual(SQLITE_DOCUMENT_DECODER);
  expect(decoder.decode(payload)).toBe(json);
  expect(decoder.extract(payload, '$."1".axon')).toBe("first");
  expect(decoder.extract(payload, "$.n")).toBe(9007199254740993n);
  expect(decoder.entries(payload).map((entry) => entry.key)).toEqual([
    "1",
    "1",
    "n",
  ]);
  expect(JSON.parse(decoder.decode(payload))["1"].axon).toBe("last");
  expect(decoder.axons(payload)).toEqual([
    { key: "1", value: "first" },
    { key: "n", value: null },
  ]);
  expect(payload).toEqual(blob(json));
});

test("retains SQL scalar types, nested compact text, missing fields and JSON null", () => {
  const payload = blob(
    '{"t":true,"f":false,"n":null,"r":0.1,"s":"a\\u0000b","o":{"a":1},"a":[1,2]}',
  );
  expect(decoder.extract(payload, "$.t")).toBe(1n);
  expect(decoder.extract(payload, "$.f")).toBe(0n);
  expect(decoder.extract(payload, "$.n")).toBeNull();
  expect(decoder.extract(payload, "$.missing")).toBeNull();
  expect(decoder.extract(payload, "$.r")).toBe(0.1);
  expect(decoder.extract(payload, "$.s")).toBe("a\0b");
  expect(
    decoder.entries(payload).find((entry) => entry.key === "s")?.value,
  ).toBe("a\0b");
  expect(decoder.extract(payload, "$.o")).toBe('{"a":1}');
  expect(decoder.extract(payload, "$.a")).toBe("[1,2]");
  expect(
    decoder.entries(blob("[true,null,1.5]")).map((entry) => entry.key),
  ).toEqual([0n, 1n, 2n]);
});

test("enforces strict live JSONB, explicit audit budgets and close state", () => {
  const text = Buffer.from("{a:1}");
  expect(() => decoder.decode(text)).toThrow("Malformed");
  expect(decoder.decode(text, "audit")).toBe('{"a":1}');
  expect(() => decoder.decode(Buffer.from([0xff]))).toThrow("Malformed");
  expect(() =>
    decoder.decode(Buffer.from([0x2b, 0xff, 0xff]), "audit"),
  ).toThrow("Malformed");
  const large = blob(JSON.stringify("x".repeat(600000)));
  expect(() => decoder.decode(large)).toThrow("budget");
  expect(decoder.decode(large, "audit")).toHaveLength(600002);
  const small = createSqliteDocumentDecoder({ maxAuditBytes: 1 });
  expect(() => small.decode(text, "audit")).toThrow("budget");
  small.close();
  small.close();
  expect(() => small.decode(blob("{}"))).toThrow("closed");
  expect(() => createSqliteDocumentDecoder({ maxAuditBytes: 0 })).toThrow(
    "budget",
  );
});

test("refuses a different or missing bundled SQLite identity", () => {
  for (const identity of [
    undefined,
    { version: "other", sourceId: "other" },
    { ...SQLITE_DOCUMENT_DECODER, sourceId: "other" },
  ]) {
    const original = DatabaseSync.prototype.prepare;
    const mock = vi
      .spyOn(DatabaseSync.prototype, "prepare")
      .mockImplementation(function (this: DatabaseSync, sql) {
        if (sql.includes("sqlite_version"))
          return { get: () => identity } as unknown as ReturnType<
            typeof original
          >;
        return original.call(this, sql);
      });
    try {
      expect(() =>
        createSqliteDocumentDecoder({ maxAuditBytes: 1024 }),
      ).toThrow("identity");
    } finally {
      mock.mockRestore();
    }
  }
});

test("tagged storage round-trips all actual SQLite storage classes without JSON number loss", () => {
  for (const value of [
    null,
    -(1n << 63n),
    (1n << 63n) - 1n,
    0.1,
    -0,
    Infinity,
    -Infinity,
    "a\0b",
    Buffer.from([0, 255]),
  ]) {
    const encoded = storeSqliteValue(value);
    expect(readSqliteValue(JSON.parse(JSON.stringify(encoded)))).toEqual(value);
  }
  expect(() => storeSqliteValue(NaN)).toThrow("NaN");
  expect(() => storeSqliteValue(1n << 63n)).toThrow("range");
  expect(() => storeSqliteValue(-(1n << 63n) - 1n)).toThrow("range");
  for (const value of [
    ["integer", "01"],
    ["integer", "-0"],
    ["integer", "9223372036854775808"],
    ["integer", "-9223372036854775809"],
    ["text", "null"],
    ["blob", "gg"],
    ["real", "00"],
    ["real", "7ff8000000000000"],
    ["unknown", "00"],
  ] as const)
    expect(() => readSqliteValue(value)).toThrow();
  for (const value of [
    undefined,
    {},
    [],
    ["text"],
    ["text", "a", "b"],
    ["text", 4],
    [true, "a"],
  ])
    expect(() => readSqliteValue(value)).toThrow("tag");
});

test("preserves raw JSON custody while scalar TEXT follows wire replacement", () => {
  const unpaired = blob('"\\ud800"');
  expect(decoder.decode(unpaired)).toBe('"\\ud800"');
  expect(decoder.extract(unpaired, "$")).toBe("\ufffd\ufffd\ufffd");
  // SQLite's strict binary-format check admits this TEXT node even though its
  // payload is not UTF8. Whole-document custody still refuses a rewrite;
  // a scalar response uses the replacement behavior verified against D1.
  const malformedText = Buffer.from([0x17, 0xff]);
  expect(
    source.prepare("SELECT json_valid(?,8) AS valid").get(malformedText)!.valid,
  ).toBe(1);
  expect(() => decoder.decode(malformedText)).toThrow();
  expect(decoder.extract(malformedText, "$")).toBe("\ufffd");
  expect(malformedText).toEqual(Buffer.from([0x17, 0xff]));
});
