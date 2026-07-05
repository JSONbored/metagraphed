import { describe, expect, it } from "vitest";

import { isValidSs58, ss58PathSegment } from "./accounts";

const VALID_SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

describe("isValidSs58", () => {
  it("accepts plausible Bittensor ss58 addresses", () => {
    expect(isValidSs58(VALID_SS58)).toBe(true);
    expect(isValidSs58(`  ${VALID_SS58}  `)).toBe(true);
  });

  it("rejects empty, short, and malformed refs", () => {
    expect(isValidSs58("")).toBe(false);
    expect(isValidSs58("   ")).toBe(false);
    expect(isValidSs58("5abc")).toBe(false);
    expect(isValidSs58(`${VALID_SS58}extra`)).toBe(false);
  });

  it("rejects base58-invalid characters", () => {
    expect(isValidSs58("0".repeat(48))).toBe(false);
    expect(isValidSs58("O".repeat(48))).toBe(false);
    expect(isValidSs58("l".repeat(48))).toBe(false);
    expect(isValidSs58(`5${"I".repeat(47)}`)).toBe(false);
  });
});

describe("ss58PathSegment", () => {
  it("returns an encoded path segment for valid ss58 refs", () => {
    expect(ss58PathSegment(VALID_SS58)).toBe(encodeURIComponent(VALID_SS58));
    expect(ss58PathSegment(`  ${VALID_SS58}  `)).toBe(encodeURIComponent(VALID_SS58));
  });

  it("throws before encoding invalid ss58 refs", () => {
    expect(() => ss58PathSegment("not-an-address")).toThrow("Invalid ss58 address");
  });
});
