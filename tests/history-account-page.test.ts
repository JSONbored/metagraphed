import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeAccountPage } from "../src/history-account-page.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/account-feeds/compact-page.json", import.meta.url),
    "utf8",
  ),
) as { base64: string; entries: [string, (number | string | null)[]][] };
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

describe("compact account page wire format", () => {
  it("reads Python output without losing tokens, nulls, Unicode or numeric bits", () => {
    const result = decodeAccountPage(original)!;
    expect(result).toEqual(
      fixture.entries.map(([token, values]) => ({ token, values })),
    );
    expect(Object.is(result[0].values[8], -0)).toBe(true);
    expect(result[0].values[9]).toBe(Number.MIN_VALUE);
    expect(result[1].values[8]).toBe(Number.MAX_VALUE);
    expect(result[0].values[4]).toBe("\ud800");
    expect(result[0].values[5]).toBe("雪\0\n");
    const padded = Buffer.concat([Buffer.alloc(3), original, Buffer.alloc(4)]);
    expect(decodeAccountPage(padded.subarray(3, -4))).toEqual(result);
  });

  it("leaves legacy pages to the existing JSONL decoder", () => {
    expect(
      decodeAccountPage(Buffer.from("a".repeat(166) + "\t[]\n")),
    ).toBeUndefined();
    expect(decodeAccountPage(new Uint8Array())).toBeUndefined();
  });

  it("rejects invalid headers, dimensions, dictionaries and trailing bytes", () => {
    const bad = [
      Buffer.from("M"),
      Buffer.from("MGA3" + "0".repeat(6)),
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
    for (const raw of bad) expect(() => decodeAccountPage(raw)).toThrow();
  });

  it("rejects noncanonical NaNs, infinities and invalid dictionary indices", () => {
    for (const column of [3, 4, 5, 11, 12])
      for (const value of [-1, 0.5, strings.length, Infinity, -Infinity])
        expect(() => decodeAccountPage(number(column, value))).toThrow();
    const nan = number(8, NaN);
    nan[cell(8)] = 1;
    expect(() => decodeAccountPage(nan)).toThrow("number");
    const negativeNan = number(8, NaN);
    negativeNan[cell(8) + 7] |= 0x80;
    expect(() => decodeAccountPage(negativeNan)).toThrow("number");
    expect(() => decodeAccountPage(number(8, Infinity))).toThrow("number");
  });

  it("rejects missing or malformed physical identity and ordering values", () => {
    for (const column of [0, 1, 10, 11, 12, 13])
      expect(() => decodeAccountPage(number(column, NaN))).toThrow("identity");
    for (const value of [-1, 0.5, 0x100000000])
      expect(() => decodeAccountPage(number(13, value))).toThrow("identity");
    for (const column of [0, 1, 10])
      for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1])
        expect(() => decodeAccountPage(number(column, value))).toThrow(
          "ordering",
        );
    for (const column of [11, 12]) {
      const changed = [...strings];
      changed[original.readDoubleLE(cell(column))] = "invalid";
      expect(() => decodeAccountPage(dictionary(changed))).toThrow("identity");
    }
  });
});
