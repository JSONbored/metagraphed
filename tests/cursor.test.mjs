import assert from "node:assert/strict";
import { test } from "vitest";
import { encodeCursor, decodeCursor } from "../src/cursor.ts";

// ---- Keyset cursor codec (#1851) ------------------------------------------

test("encodeCursor + decodeCursor round-trip a composite key", () => {
  const token = encodeCursor([7270283, 2]);
  assert.equal(token, "7270283.2");
  assert.deepEqual(decodeCursor(token, 2), [7270283, 2]);
});

test("encodeCursor round-trips a single-part (blocks) key", () => {
  const token = encodeCursor([999]);
  assert.equal(token, "999");
  assert.deepEqual(decodeCursor(token, 1), [999]);
});

test("cursor tokens are URL-safe (digits + dots only)", () => {
  const token = encodeCursor([4294967295, 4294967294]);
  assert.ok(/^[0-9.]+$/.test(token), `token not URL-safe: ${token}`);
  assert.deepEqual(decodeCursor(token, 2), [4294967295, 4294967294]);
});

test("encodeCursor round-trips D1 numeric-string PK parts", () => {
  const token = encodeCursor(["7270283", "2"]);
  assert.equal(token, "7270283.2");
  assert.deepEqual(decodeCursor(token, 2), [7270283, 2]);
  assert.equal(encodeCursor(["150"]), "150");
});

test("encodeCursor rejects empty/negative/non-integer input", () => {
  assert.equal(encodeCursor([]), null);
  assert.equal(encodeCursor([-1]), null);
  assert.equal(encodeCursor([1.5]), null);
  assert.equal(encodeCursor("nope"), null);
  assert.equal(encodeCursor(["12x"]), null);
  assert.equal(encodeCursor(["9007199254740993"]), null);
});

test("decodeCursor returns null on malformed/garbage/arity-mismatch", () => {
  assert.equal(decodeCursor("", 1), null);
  assert.equal(decodeCursor(null, 1), null);
  assert.equal(decodeCursor("1.x", 2), null); // non-digit segment
  assert.equal(decodeCursor("200.", 2), null); // empty trailing segment
  assert.equal(decodeCursor("1.2.3", 2), null); // arity mismatch (3 != 2)
  assert.equal(decodeCursor(encodeCursor([1, 2]), 1), null); // 2-part token as 1
  assert.equal(decodeCursor("-1.2", 2), null); // negative
});

test("decodeCursor rejects parts above MAX_SAFE_INTEGER (no silent Number() rounding)", () => {
  // `/^\d+$/` admits arbitrarily long digit strings; Number() rounds anything past
  // MAX_SAFE_INTEGER (2^53 - 1), so "9007199254740993" parses to 9007199254740992 —
  // a corrupted seek key. It must be rejected, not silently rounded and accepted.
  const unsafe = "9007199254740993"; // MAX_SAFE_INTEGER + 2, not exactly representable
  assert.equal(decodeCursor(unsafe, 1), null);
  assert.equal(decodeCursor(`1.${unsafe}`, 2), null);
  assert.equal(decodeCursor(`${unsafe}.2`, 2), null);
  // The exact first unsafe integer (2^53 = MAX_SAFE_INTEGER + 1) is also rejected.
  // It IS exactly representable in IEEE-754 but fails Number.isSafeInteger, so
  // the gate rejects it just as decisively as a visibly-rounded value.
  const firstUnsafe = String(Number.MAX_SAFE_INTEGER + 1); // "9007199254740992"
  assert.equal(decodeCursor(firstUnsafe, 1), null);
  // The exact MAX_SAFE_INTEGER boundary is still a valid, representable cursor.
  const safe = String(Number.MAX_SAFE_INTEGER); // "9007199254740991"
  assert.deepEqual(decodeCursor(safe, 1), [Number.MAX_SAFE_INTEGER]);
});

test("encodeCursor rejects a part above MAX_SAFE_INTEGER", () => {
  assert.equal(encodeCursor([2 ** 53]), null); // 9007199254740992, unsafe
  assert.equal(encodeCursor([1, 2 ** 53]), null);
  // The boundary value itself still round-trips.
  assert.equal(
    encodeCursor([Number.MAX_SAFE_INTEGER]),
    String(Number.MAX_SAFE_INTEGER),
  );
});
