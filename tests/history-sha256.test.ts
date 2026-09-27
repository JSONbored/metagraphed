import { sha256Hex } from "../src/sha256-hex.ts";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { historyJson, historySha256 } from "../src/history-sha256.ts";

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
