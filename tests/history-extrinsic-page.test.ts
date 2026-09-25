import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeExtrinsicPage } from "../src/history-extrinsic-page.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/extrinsic-feeds/compact-page.json", import.meta.url),
    "utf8",
  ),
) as {
  base64: string;
  entries: [string, (number | string | boolean | null)[]][];
};
const original = Buffer.from(fixture.base64, "base64");
const count = original.readUInt16LE(4);
const start = 10 + original.readUInt32LE(6);
const cell = (column: number, index = 0) =>
  start + (column * count + index) * 8;
function number(column: number, value: number) {
  const copy = Buffer.from(original);
  copy.writeDoubleLE(value, cell(column));
  return copy;
}
function dictionary(value: unknown) {
  const raw = Buffer.from(JSON.stringify(value));
  const header = Buffer.from(original.subarray(0, 10));
  header.writeUInt32LE(raw.length, 6);
  return Buffer.concat([header, raw, original.subarray(start)]);
}
const strings: string[] = JSON.parse(original.subarray(10, start).toString());

describe("compact extrinsic page wire format", () => {
  it("reads Python output without losing tokens, nulls, Unicode or numeric bits", () => {
    const result = decodeExtrinsicPage(original)!;
    expect(result).toEqual(
      fixture.entries.map(([token, values]) => ({ token, values })),
    );
    expect(result[0].values[6]).toBe(true);
    expect(result[1].values[6]).toBe(false);
    expect(result[2].values[6]).toBeNull();
    expect(result[1].values[3]).toBe("\ud800");
    expect(result[1].values[4]).toBe("雪\0\n");
    const padded = Buffer.concat([Buffer.alloc(3), original, Buffer.alloc(4)]);
    expect(decodeExtrinsicPage(padded.subarray(3, -4))).toEqual(result);
  });

  it("leaves legacy pages to the existing JSONL decoder", () => {
    expect(
      decodeExtrinsicPage(Buffer.from("a".repeat(166) + "\t[]\n")),
    ).toBeUndefined();
    expect(decodeExtrinsicPage(new Uint8Array())).toBeUndefined();
  });

  it("rejects invalid headers, dimensions, dictionaries and trailing bytes", () => {
    const bad = [
      Buffer.from("M"),
      Buffer.from("MGE2" + "0".repeat(6)),
      Buffer.from(original.subarray(0, -1)),
      Buffer.concat([original, Buffer.alloc(1)]),
      Buffer.concat([original, Buffer.alloc(256 * 1024)]),
      dictionary({}),
      dictionary([1]),
      dictionary(Array(count * 5 + 1).fill("a")),
    ];
    for (const n of [0, 257]) {
      const raw = Buffer.from(original);
      raw.writeUInt16LE(n, 4);
      bad.push(raw);
    }
    const length = Buffer.from(original);
    length.writeUInt32LE(0xffffffff, 6);
    bad.push(length);
    const json = Buffer.from(original);
    json[10] = 0xff;
    bad.push(json);
    const invalidJson = Buffer.from(original);
    invalidJson[10] = 0x7d;
    bad.push(invalidJson);
    for (const raw of bad) expect(() => decodeExtrinsicPage(raw)).toThrow();
  });

  it("rejects noncanonical NaNs, infinities and invalid dictionary indices", () => {
    for (const column of [3, 4, 5, 8, 9])
      for (const value of [-1, 0.5, strings.length, Infinity, -Infinity])
        expect(() => decodeExtrinsicPage(number(column, value))).toThrow();
    const nan = number(7, NaN);
    nan[cell(7)] = 1;
    expect(() => decodeExtrinsicPage(nan)).toThrow("number");
    const negativeNan = number(7, NaN);
    negativeNan[cell(7) + 7] |= 0x80;
    expect(() => decodeExtrinsicPage(negativeNan)).toThrow("number");
    expect(() => decodeExtrinsicPage(number(7, Infinity))).toThrow("number");
  });

  it("rejects non-boolean flags and out-of-range file ids", () => {
    for (const value of [-1, 0.5, 2])
      expect(() => decodeExtrinsicPage(number(6, value))).toThrow("boolean");
    for (const value of [-1, 0.5, 0x100000000, NaN])
      expect(() => decodeExtrinsicPage(number(7, value))).toThrow();
  });

  it("rejects missing or malformed physical identity and ordering values", () => {
    for (const column of [0, 1, 2, 8, 9, 10])
      expect(() => decodeExtrinsicPage(number(column, NaN))).toThrow(
        "identity",
      );
    for (const value of [-1, 0.5, 0x100000000])
      expect(() => decodeExtrinsicPage(number(10, value))).toThrow("identity");
    for (const column of [0, 1, 2])
      for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1])
        expect(() => decodeExtrinsicPage(number(column, value))).toThrow(
          "ordering",
        );
    for (const column of [8, 9]) {
      const changed = [...strings];
      changed[original.readDoubleLE(cell(column))] = "invalid";
      expect(() => decodeExtrinsicPage(dictionary(changed))).toThrow(
        "identity",
      );
    }
  });
});
