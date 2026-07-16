import { describe, it, expect } from "vitest";
import { isValidBlockRef, blockRefPathSegment, shortHash } from "./blocks";

describe("isValidBlockRef", () => {
  it("accepts decimal block numbers (no leading zeros, up to 20 digits)", () => {
    expect(isValidBlockRef("0")).toBe(true);
    expect(isValidBlockRef("1")).toBe(true);
    expect(isValidBlockRef("12345678")).toBe(true);
    expect(isValidBlockRef("18446744073709551615")).toBe(true); // 2^64 - 1, 20 digits
  });

  it("rejects malformed decimals", () => {
    expect(isValidBlockRef("01")).toBe(false); // leading zero
    expect(isValidBlockRef("123456789012345678901")).toBe(false); // 21 digits
    expect(isValidBlockRef("-1")).toBe(false);
    expect(isValidBlockRef("1.5")).toBe(false);
    expect(isValidBlockRef("")).toBe(false);
  });

  it("accepts 0x-prefixed hex hashes", () => {
    expect(isValidBlockRef("0xabc123")).toBe(true);
    expect(isValidBlockRef("0xDEADBEEF")).toBe(true);
    expect(isValidBlockRef(`0x${"a".repeat(128)}`)).toBe(true);
  });

  it("rejects malformed hex hashes", () => {
    expect(isValidBlockRef("0x")).toBe(false); // no digits
    expect(isValidBlockRef("0xghij")).toBe(false); // non-hex
    expect(isValidBlockRef(`0x${"a".repeat(129)}`)).toBe(false); // too long
    expect(isValidBlockRef("abc123")).toBe(false); // missing 0x
  });
});

describe("blockRefPathSegment", () => {
  it("returns an encoded segment for a valid ref", () => {
    expect(blockRefPathSegment("12345")).toBe("12345");
    expect(blockRefPathSegment("0xabc")).toBe("0xabc");
  });

  it("throws on an invalid ref", () => {
    expect(() => blockRefPathSegment("01")).toThrow("Invalid block ref");
    expect(() => blockRefPathSegment("../etc")).toThrow("Invalid block ref");
    expect(() => blockRefPathSegment("")).toThrow("Invalid block ref");
  });
});

describe("shortHash", () => {
  it("returns undefined for empty / nullish / whitespace input", () => {
    expect(shortHash(undefined)).toBeUndefined();
    expect(shortHash(null)).toBeUndefined();
    expect(shortHash("")).toBeUndefined();
    expect(shortHash("   ")).toBeUndefined();
  });

  it("returns short values unchanged", () => {
    expect(shortHash("0x1234")).toBe("0x1234"); // <= keep*2 + 1
    expect(shortHash("abc", 1)).toBe("abc");
  });

  it("truncates long values with an ellipsis", () => {
    expect(shortHash("0x1234567890abcdef")).toBe("0x1234…abcdef");
    expect(shortHash("0123456789", 2)).toBe("01…89");
  });

  it("trims before measuring", () => {
    expect(shortHash("  0x1234  ")).toBe("0x1234");
  });
});
