import { afterAll, expect, test } from "vitest";
import { createSqliteDocumentDecoder } from "../src/sqlite-document-decoder.ts";

const decoder = createSqliteDocumentDecoder({ maxAuditBytes: 1024 * 1024 });
afterAll(() => decoder.close());

test("integer projections retain SQLite key coercion and array entries", () => {
  const payload = decoder.encode(
    '{"02":{"x":2},"2.5":{"x":3},"2":{"x":4},"2":{"x":5},"word":{"x":6},"123e5":{"x":7}}',
  );
  expect(
    decoder
      .metricEntries(payload, ["x"], ["2"], false, "integer")
      .map(({ key, integerKey, values }) => [key, integerKey, values.x]),
  ).toEqual([
    ["02", 2n, 2n],
    ["2.5", 2n, 3n],
    ["2", 2n, 4n],
    ["2", 2n, 5n],
  ]);
  expect(
    decoder
      .metricEntries(payload, ["x"], undefined, false, "integer")
      .map(({ integerKey }) => integerKey),
  ).toEqual([2n, 2n, 2n, 2n, 0n, 123n]);
  expect(
    decoder.metricEntries(
      decoder.encode("null"),
      ["x"],
      undefined,
      false,
      "integer",
    ),
  ).toEqual([]);
  const array = decoder.encode('[{"x":1},{"x":2}]');
  expect(decoder.metricEntries(array, ["x"])).toEqual([]);
  expect(decoder.metricEntries(array, [], ["1"], true, "integer")).toEqual([
    { key: "1", integerKey: 1n, values: {}, textBytes: {} },
  ]);
});

test("multi-path tuples preserve JSON spelling, duplicate objects, booleans and escaped scalar text", () => {
  const payload = decoder.encode(
    '{"2":{"a":true,"b":{"x":1,"x":2},"c":9007199254740993,"d":9e999,"e":"\\ud800"},"02":{"a":false},"9":null}',
  );
  expect(
    decoder.metricTuples(payload, ["a", "b", "c", "d", "e"], ["2"], "integer"),
  ).toEqual([
    {
      key: "2",
      integerKey: 2n,
      json: '[true,{"x":1,"x":2},9007199254740993,9e999,"\\ud800"]',
    },
    { key: "02", integerKey: 2n, json: "[false,null,null,null,null]" },
  ]);
  expect(decoder.metricTuples(payload, ["a", "b"], ["2"])).toEqual([
    { key: "2", json: '[true,{"x":1,"x":2}]' },
  ]);
  expect(
    decoder.metricTuples(payload, ["a", "b"], undefined, "integer").at(-1)
      ?.json,
  ).toBeNull();
  expect(
    decoder.metricTuples(
      decoder.encode('[{"a":1,"b":2}]'),
      ["a", "b"],
      ["0"],
      "integer",
    ),
  ).toEqual([{ key: "0", integerKey: 0n, json: "[1,2]" }]);
});

test("projection validation bounds tuple fields and refuses malformed selected metrics", () => {
  const payload = decoder.encode('{"1":{}}');
  expect(() => decoder.metricTuples(payload, ["a"])).toThrow("multiple fields");
  for (const fields of [
    ["a", "a"],
    ["bad.path", "a"],
    Array.from({ length: 33 }, (_, i) => `a${i}`),
  ])
    expect(() => decoder.metricTuples(payload, fields)).toThrow("projection");
  expect(() =>
    decoder.metricEntries(payload, [], undefined, false, "bad" as "text"),
  ).toThrow("projection");
  expect(() =>
    decoder.metricTuples(decoder.encode('{"1":"not-json"}'), ["a", "b"], ["1"]),
  ).toThrow("malformed JSON");
  expect(
    decoder.metricTuples(decoder.encode('{"1":"not-json"}'), ["a", "b"], []),
  ).toEqual([]);
});

test("predicate validation includes malformed orphan and top-level entries", () => {
  for (const json of ['{"1":"malformed"}', '"malformed"'])
    expect(() =>
      decoder.validateMetricEntries(decoder.encode(json), "validator_permit"),
    ).toThrow("malformed");
  expect(() =>
    decoder.validateMetricEntries(
      decoder.encode('{"1":{"n":9223372036854775807}}'),
      "n",
    ),
  ).not.toThrow();
  expect(() =>
    decoder.validateMetricEntries(decoder.encode("{}"), "bad.path"),
  ).toThrow("projection");
});
