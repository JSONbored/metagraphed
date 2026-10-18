import { sha256Hex } from "../src/sha256-hex.ts";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { boundedHistoryJsonSha256, historyJson, historySha256 } from "../src/history-sha256.ts";

it.each([
  [null, "null"],
  [false, "false"],
  ["é🌐", '"é🌐"'],
  [
    { z: [2, null, { b: true, a: "1" }], a: 0 },
    '{"a":0,"z":[2,null,{"a":"1","b":true}]}',
  ],
  [{ z: undefined, a: [undefined, "x"] }, '{"a":[,"x"],"z":undefined}'],
])("preserves the historical canonical encoding for %j", (value, encoded) => {
  expect(historyJson(value)).toBe(encoded);
  expect(historySha256(historyJson(value))).toBe(
    createHash("sha256")
      .update(encoded as string)
      .digest("hex"),
  );
});

it("hashes only the supplied byte view and preserves UTF-8 replacement", () => {
  const bytes = new TextEncoder().encode("prefix-é🌐-suffix");
  const view = bytes.subarray(7, bytes.length - 7);
  expect(historySha256(view)).toBe(historySha256("é🌐"));
  expect(historySha256("\ud800")).toBe(historySha256("\ufffd"));
});

it("Web Crypto digests preserve exact text without Node compatibility", async () => {
  for (const value of [
    "",
    "plain",
    "界\ud83d\ude00",
    "\ud800",
    "salt:127.0.0.1",
  ])
    expect(await sha256Hex(value)).toBe(historySha256(value));
});

it("streams exact canonical bytes with inclusive byte limits and no prefix digest", () => {
  const sparse = new Array(3); sparse[1] = undefined;
  for (const value of [null, false, "", "é🌐", "a".repeat(8191) + "🌐\ud800\n\"", sparse,
    { z: undefined, a: [undefined, "x"], b: { x: 1 } }]) {
    const encoded = historyJson(value) + "\n";
    const bytes = Buffer.byteLength(encoded);
    expect(boundedHistoryJsonSha256([value], bytes, 64)).toBe(historySha256(encoded));
    expect(boundedHistoryJsonSha256([value], bytes - 1, 64)).toBeNull();
  }
  expect(boundedHistoryJsonSha256([], 0, 0)).toBe(historySha256(""));
  expect(boundedHistoryJsonSha256([{}], 3, 0)).toBe(historySha256("{}\n"));
  expect(boundedHistoryJsonSha256([{ a: "x" }], 3, 64)).toBeNull();
});

it("bounds depth, oversized strings, arrays and objects before hashing a full payload", () => {
  let nested: unknown = 0;
  for (let depth = 0; depth < 64; depth += 1) nested = [nested];
  expect(boundedHistoryJsonSha256([nested], 1000, 64)).toBe(historySha256(historyJson(nested) + "\n"));
  expect(boundedHistoryJsonSha256([[nested]], 1000, 64)).toBeNull();
  expect(boundedHistoryJsonSha256(["x".repeat(100)], 10, 64)).toBeNull();
  expect(boundedHistoryJsonSha256([[1, 2, 3]], 2, 64)).toBeNull();
  expect(boundedHistoryJsonSha256([{ a: 1, b: 2 }], 3, 64)).toBeNull();
});

it("refuses every incomplete canonical prefix across punctuation, keys, escapes and rows", () => {
  for (const value of [{ abc: [1, null, "界\""], z: false }, [1, 2], { "": "" }, undefined, "\ud800", true, 1]) {
    const encoded = historyJson(value) + "\n";
    const size = Buffer.byteLength(encoded);
    for (let budget = 0; budget < size; budget += 1)
      expect(boundedHistoryJsonSha256([value], budget, 64)).toBeNull();
    expect(boundedHistoryJsonSha256([value], size, 64)).toBe(historySha256(encoded));
  }
  expect(boundedHistoryJsonSha256([1, 2], 4, 64)).toBe(historySha256("1\n2\n"));
  expect(boundedHistoryJsonSha256([1, 2], 3, 64)).toBeNull();
});
