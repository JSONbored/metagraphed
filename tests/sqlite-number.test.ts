import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import {
  sqliteNumberDecimal,
  sqliteNumericNumber,
  sqliteAddNumbers,
  sqliteIntegerAffinity,
  sqliteStoredNumber,
  sqliteStoredNumberText,
} from "../src/sqlite-number.ts";

test("exact binary64 decimals match independently generated Python Decimal vectors", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("./fixtures/sqlite-number-values.json", import.meta.url),
      "utf8",
    ),
  ) as { values: { bits: string; decimal: string }[] };
  for (const { bits, decimal } of fixture.values) {
    const value = Buffer.from(bits, "hex").readDoubleBE();
    assert.equal(sqliteNumberDecimal(value), decimal, bits);
    assert.equal(sqliteNumericNumber(decimal), value === 0 ? 0 : value, bits);
  }
  for (const value of [Infinity, -Infinity, NaN])
    assert.throws(() => sqliteNumberDecimal(value), /finite/);
  for (const value of [null, {}, "", "NaN", "1e3", " 1"])
    assert.throws(() => sqliteNumericNumber(value), /representation/);
  assert.throws(() => sqliteNumericNumber("9".repeat(400)), /finite/);
  assert.equal(sqliteNumericNumber(1.25), 1.25);
});

test("storage-sensitive numeric cells retain INTEGER arithmetic and REAL affinity", () => {
  const integer = sqliteStoredNumber("9007199254740993");
  assert.deepEqual(integer, { kind: "integer", value: 9007199254740993n });
  assert.equal(
    sqliteStoredNumberText(sqliteAddNumbers(integer, sqliteIntegerAffinity(1))),
    "9007199254740994",
  );
  const minimum = sqliteStoredNumber("-9223372036854775808");
  const minimumReal = sqliteStoredNumber("-9223372036854775808.0");
  assert.equal(
    sqliteStoredNumberText(sqliteAddNumbers(minimum, sqliteIntegerAffinity(1))),
    "-9223372036854775807",
  );
  assert.equal(
    sqliteStoredNumberText(
      sqliteAddNumbers(minimumReal, sqliteIntegerAffinity(1)),
    ),
    "-9223372036854775808.0",
  );
  assert.equal(
    sqliteStoredNumberText(
      sqliteAddNumbers(
        sqliteStoredNumber("9223372036854775807"),
        sqliteIntegerAffinity(1),
      ),
    ),
    "9223372036854775808.0",
  );
  assert.equal(
    sqliteStoredNumberText(
      sqliteAddNumbers(minimum, sqliteIntegerAffinity(-1)),
    ),
    "-9223372036854775808.0",
  );
  assert.equal(
    sqliteStoredNumberText(
      sqliteAddNumbers(sqliteIntegerAffinity(0.5), sqliteIntegerAffinity(0.5)),
    ),
    "1",
  );
  assert.equal(sqliteStoredNumberText(sqliteIntegerAffinity(0.5)), "0.5");
  for (const value of [Infinity, -Infinity, NaN])
    assert.throws(() => sqliteIntegerAffinity(value), /finite/);
  for (const value of ["9223372036854775808", "-9223372036854775809"])
    assert.throws(() => sqliteStoredNumber(value), /int64/);
});
