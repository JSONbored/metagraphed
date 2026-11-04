import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createSqliteSum,
  sqliteAggregateNumber,
  sqliteAggregateText,
  sqliteJsonNumber,
} from "../src/sqlite-sum.ts";

test("aggregate storage preserves integer, REAL and infinite kinds", () => {
  for (const text of [
    "0",
    "-42",
    "9007199254740993",
    "0.5",
    "Infinity",
    "-Infinity",
  ])
    assert.equal(sqliteAggregateText(sqliteAggregateNumber(text)), text);
  assert.equal(sqliteAggregateText(sqliteAggregateNumber("1.0")), "1");
  assert.throws(() => sqliteAggregateText(null), /NULL/);
  assert.throws(
    () => sqliteAggregateText({ kind: "real", value: NaN }),
    /NULL/,
  );
});

test("JSON1 number parsing uses the serialized decimal token", () => {
  assert.deepEqual(sqliteJsonNumber(1e18 + 128), {
    kind: "integer",
    value: 1000000000000000100n,
  });
  assert.deepEqual(sqliteJsonNumber(-0), { kind: "integer", value: 0n });
  assert.deepEqual(sqliteJsonNumber(1e20), { kind: "real", value: 1e20 });
  assert.deepEqual(sqliteJsonNumber(0.1), { kind: "real", value: 0.1 });
});

test("typed aggregate values retain the SQLite SUM boundary behavior", () => {
  const sum = (
    ...values: Parameters<ReturnType<typeof createSqliteSum>["add"]>[0][]
  ) => {
    const accumulator = createSqliteSum();
    for (const value of values) accumulator.add(value);
    return accumulator.value();
  };
  assert.equal(sum(null), null);
  assert.deepEqual(
    sum({ kind: "integer", value: 1n }, { kind: "integer", value: 2n }),
    { kind: "integer", value: 3n },
  );
  assert.deepEqual(
    sum({ kind: "real", value: 0.1 }, { kind: "integer", value: 1n }),
    { kind: "real", value: 1.1 },
  );
  assert.deepEqual(
    sum({ kind: "real", value: 0 }, { kind: "integer", value: -(1n << 53n) }),
    { kind: "real", value: -(2 ** 53) },
  );
  assert.deepEqual(
    sum({ kind: "real", value: Infinity }, { kind: "integer", value: 1n }),
    { kind: "real", value: Infinity },
  );
  assert.equal(
    sum({ kind: "real", value: Infinity }, { kind: "real", value: -Infinity }),
    null,
  );
  assert.throws(
    () =>
      sum(
        { kind: "integer", value: 9223372036854775807n },
        { kind: "integer", value: 1n },
      ),
    /overflow/,
  );
});
