import { describe, expect, it } from "vitest";

import {
  isChecksumValidSs58,
  isValidH160,
  isValidSs58,
  normalizeH160,
  ss58PathSegment,
} from "./accounts";

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

describe("isValidH160 / normalizeH160 (metagraphed-infra#373)", () => {
  const ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";

  it("accepts a well-formed EVM address in either case", () => {
    expect(isValidH160(ADDRESS)).toBe(true);
    expect(isValidH160(ADDRESS.toUpperCase().replace("0X", "0x"))).toBe(true);
    expect(isValidH160(`  ${ADDRESS}  `)).toBe(true);
  });

  it("requires the 0x, matching /api/v1/search/resolve", () => {
    // Forty bare hex characters are far more likely to be something pasted by
    // accident than an EVM address. The two recognisers disagreeing about that
    // is how a paste resolves one way in the search box and another on the page
    // it lands on.
    expect(isValidH160(ADDRESS.slice(2))).toBe(false);
  });

  it("rejects the wrong length and non-hex", () => {
    expect(isValidH160(`${ADDRESS}0`)).toBe(false);
    expect(isValidH160(ADDRESS.slice(0, -1))).toBe(false);
    expect(isValidH160(`0x${"g".repeat(40)}`)).toBe(false);
    // A 32-byte hash is not an account address, and offering it as one would
    // send a block-hash paste to a lookup that can only fail.
    expect(isValidH160(`0x${"a".repeat(64)}`)).toBe(false);
  });

  it("does not mistake an ss58 for an EVM address, or the reverse", () => {
    const SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
    expect(isValidH160(SS58)).toBe(false);
    expect(isValidSs58(ADDRESS)).toBe(false);
  });

  it("lowercases, so a checksummed paste is one cache key and one URL", () => {
    expect(normalizeH160(`  0x1234567890ABCDEF1234567890abcdef12345678 `)).toBe(ADDRESS);
  });
});

describe("isChecksumValidSs58 (metagraphed-infra#376)", () => {
  // Alice, the address /api/v1/search/resolve's own tests use.
  const ALICE = "5C4hrfjw9DjXZTzV3MwzrrAr9P1MJhSrvWGWqi1eSuyUpnhM";

  it("accepts a real address", () => {
    expect(isChecksumValidSs58(ALICE)).toBe(true);
    expect(isChecksumValidSs58(`  ${ALICE}  `)).toBe(true);
    expect(isChecksumValidSs58(VALID_SS58)).toBe(true);
  });

  it("REJECTS a one-character typo the shape check accepts", () => {
    // The whole reason this exists. A mutated last character is still 48 base58
    // characters, so isValidSs58 offers it -- and the user lands on an account
    // page rendering "no activity", which reads as a fact about the address
    // rather than as "you mistyped it".
    const typo = `${ALICE.slice(0, -1)}X`;
    expect(typo).toHaveLength(ALICE.length);
    expect(isValidSs58(typo)).toBe(true);
    expect(isChecksumValidSs58(typo)).toBe(false);
  });

  it("rejects prose, an EVM address, and non-strings", () => {
    for (const bad of ["", "  ", "inference", "0x".padEnd(42, "a"), null, 7, {}]) {
      expect(isChecksumValidSs58(bad)).toBe(false);
    }
  });

  it("leaves the lenient check alone for its other callers", () => {
    // isValidSs58 stays a shape check on purpose: its other 39 call sites
    // format an address that already came from the chain, or build an extrinsic
    // from one the wallet supplied. Neither can be a typo.
    expect(isValidSs58(`${ALICE.slice(0, -1)}X`)).toBe(true);
  });
});
