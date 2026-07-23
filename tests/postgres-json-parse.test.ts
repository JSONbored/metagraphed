import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { parseJsonPreservingBigIntegers } from "../src/postgres-json-parse.ts";

describe("parseJsonPreservingBigIntegers", () => {
  test("parses ordinary JSON identically to JSON.parse", () => {
    const text = JSON.stringify({
      a: 1,
      b: "two",
      c: [3, 4, 5],
      d: null,
      e: true,
      f: -42,
      g: { nested: "object" },
    });
    assert.deepEqual(parseJsonPreservingBigIntegers(text), JSON.parse(text));
  });

  test("preserves a u64::MAX integer as an exact string (real SubtensorModule.DifficultySet, block 4132551/0)", () => {
    const text = "[13, 18446744073709551615]";
    assert.deepEqual(parseJsonPreservingBigIntegers(text), [
      13,
      "18446744073709551615",
    ]);
  });

  test("preserves a large negative integer as an exact string", () => {
    const text = "[-18446744073709551615]";
    assert.deepEqual(parseJsonPreservingBigIntegers(text), [
      "-18446744073709551615",
    ]);
  });

  test("leaves an integer at exactly Number.MAX_SAFE_INTEGER as a number", () => {
    const text = `[${Number.MAX_SAFE_INTEGER}]`;
    assert.deepEqual(parseJsonPreservingBigIntegers(text), [
      Number.MAX_SAFE_INTEGER,
    ]);
    assert.equal(
      typeof (parseJsonPreservingBigIntegers(text) as unknown[])[0],
      "number",
    );
  });

  test("converts an integer one past Number.MAX_SAFE_INTEGER to a string", () => {
    const text = `[${Number.MAX_SAFE_INTEGER}0]`; // 90071992547409910
    const [value] = parseJsonPreservingBigIntegers(text) as unknown[];
    assert.equal(typeof value, "string");
    assert.equal(value, "90071992547409910");
  });

  test("does not touch a digit run inside a quoted string, even a hostile one matching the same length/shape as a real u64::MAX field", () => {
    const text = JSON.stringify({
      account: "5HHBZRFX9UiyG77qU1pn1qMceRYKeg2a4yGBwPCHCyDocX4i",
      note: "contains18446744073709551615digits",
      hash: "0x18446744073709551615aabbccddee",
    });
    assert.deepEqual(parseJsonPreservingBigIntegers(text), JSON.parse(text));
  });

  test("leaves fractional and exponential numbers untouched even when they exceed safe-integer magnitude", () => {
    const text = "[1.5e21, 3.14159, -2.5e-10]";
    assert.deepEqual(parseJsonPreservingBigIntegers(text), JSON.parse(text));
  });

  test("handles big integers nested deep inside objects and arrays (real SubtensorModule.SetChildren shape, block 8603683/133)", () => {
    const text =
      '{"parent":"5F...","children":[[[9042069731475589000,"5G..."],[6776677281062051000,"5H..."]]]}';
    const parsed = parseJsonPreservingBigIntegers(text);
    assert.deepEqual(parsed, {
      parent: "5F...",
      children: [
        [
          ["9042069731475589000", "5G..."],
          ["6776677281062051000", "5H..."],
        ],
      ],
    });
  });

  test("round-trips an escaped quote inside a string without breaking token boundaries", () => {
    const text = String.raw`{"note": "she said \"hi\" then 18446744073709551615 things happened"}`;
    assert.deepEqual(parseJsonPreservingBigIntegers(text), {
      note: 'she said "hi" then 18446744073709551615 things happened',
    });
  });
});
