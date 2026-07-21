import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { parseJsonPreservingBigInts } from "../src/big-int-safe-json.ts";

describe("parseJsonPreservingBigInts", () => {
  test("preserves a large integer literal as an exact string instead of rounding it (the real corruption case caught by Gittensory review on #4692's original PR)", () => {
    // The exact value cited throughout this session's SubtensorModule.register
    // PoW nonce example -- D1 was found serving 9131459485341369000 for the
    // true 9131459485341369597. Plain JSON.parse reproduces that exact
    // corruption; this must not.
    const text = '{"nonce":[9131459485341369597]}';
    const parsed = parseJsonPreservingBigInts(text);
    assert.equal(typeof parsed.nonce[0], "string");
    assert.equal(parsed.nonce[0], "9131459485341369597");
  });

  test("preserves a large limb inside a nested U256 array shape", () => {
    const text = '{"value":[[9131459485341369597,0,0,0]]}';
    const parsed = parseJsonPreservingBigInts(text);
    assert.equal(parsed.value[0][0], "9131459485341369597");
    assert.equal(parsed.value[0][1], 0);
  });

  test("leaves small integers as plain numbers, unaffected", () => {
    const text = '{"netuid":9,"nonce":69392,"list":[1,2,3]}';
    assert.deepEqual(parseJsonPreservingBigInts(text), {
      netuid: 9,
      nonce: 69392,
      list: [1, 2, 3],
    });
  });

  test("leaves Number.MAX_SAFE_INTEGER itself as a plain number (boundary, not past it)", () => {
    const text = `{"n":${Number.MAX_SAFE_INTEGER}}`;
    const parsed = parseJsonPreservingBigInts(text);
    assert.equal(typeof parsed.n, "number");
    assert.equal(parsed.n, Number.MAX_SAFE_INTEGER);
  });

  test("wraps Number.MAX_SAFE_INTEGER + 1 as a string (just past the boundary)", () => {
    const justPast = (BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString();
    const parsed = parseJsonPreservingBigInts(`{"n":${justPast}}`);
    assert.equal(typeof parsed.n, "string");
    assert.equal(parsed.n, justPast);
  });

  test("does not mistake digits inside a string value for a bare number literal", () => {
    // An SS58 address, a base58 string, or any string that happens to contain
    // a long digit run must not get quoted a second time or otherwise mangled
    // -- the string-token alternative in the regex must consume it whole.
    const text =
      '{"note":"contains 99999999999999999999999999999 digits inside a string"}';
    assert.deepEqual(parseJsonPreservingBigInts(text), {
      note: "contains 99999999999999999999999999999 digits inside a string",
    });
  });

  test("does not mistake digits inside a string containing an escaped quote", () => {
    const text = '{"note":"a \\"quoted\\" 99999999999999999999 value"}';
    assert.deepEqual(parseJsonPreservingBigInts(text), {
      note: 'a "quoted" 99999999999999999999 value',
    });
  });

  test("preserves a negative large integer as a string", () => {
    const text = '{"n":-9131459485341369597}';
    const parsed = parseJsonPreservingBigInts(text);
    assert.equal(parsed.n, "-9131459485341369597");
  });

  test("leaves a decimal (non-integer) large literal as a plain number -- Number() is already the only sane representation for a fractional value", () => {
    const text = '{"n":123456789012345678901.5}';
    const parsed = parseJsonPreservingBigInts(text);
    assert.equal(typeof parsed.n, "number");
  });

  test("is a no-op on a payload with no large integers anywhere (matches plain JSON.parse exactly)", () => {
    const text =
      '{"call_module":"SubtensorModule","call_function":"transfer_stake","call_args":{"netuid":9,"alpha_amount":3358540310}}';
    assert.deepEqual(parseJsonPreservingBigInts(text), JSON.parse(text));
  });

  test("handles booleans and null without disturbing them", () => {
    const text = '{"success":true,"absent":null,"other":false}';
    assert.deepEqual(parseJsonPreservingBigInts(text), {
      success: true,
      absent: null,
      other: false,
    });
  });
});
