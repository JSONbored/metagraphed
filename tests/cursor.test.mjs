import assert from "node:assert/strict";
import { test } from "vitest";
import { encodeCursor, decodeCursor } from "../src/cursor.mjs";

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

test("encodeCursor rejects empty/negative/non-integer input", () => {
  assert.equal(encodeCursor([]), null);
  assert.equal(encodeCursor([-1]), null);
  assert.equal(encodeCursor([1.5]), null);
  assert.equal(encodeCursor("nope"), null);
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
