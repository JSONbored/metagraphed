import { describe, it, expect } from "vitest";
import { blake2b, base58Encode, base58Decode, encodeSs58, decodeSs58 } from "./ss58";

const hex = (h: string) =>
  Uint8Array.from(
    h
      .replace(/^0x/, "")
      .match(/../g)!
      .map((b) => parseInt(b, 16)),
  );
const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

describe("blake2b", () => {
  // Known blake2b-512 vectors (RFC 7693 style — empty + "abc").
  it("hashes the empty input", () => {
    expect(toHex(blake2b(new Uint8Array(0), 64))).toBe(
      "786a02f742015903c6c6fd852552d272912f4740e15847618a86e217f71f5419" +
        "d25e1031afee585313896444934eb04b903a685b1448b755d56f701afe9be2ce",
    );
  });
  it('hashes "abc"', () => {
    expect(toHex(blake2b(new TextEncoder().encode("abc"), 64))).toBe(
      "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d1" +
        "7d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923",
    );
  });
});

describe("base58Encode", () => {
  it("encodes bytes and preserves leading-zero '1's", () => {
    expect(base58Encode(hex("0x0000287fb4cd"))).toBe("11233QC4");
  });
});

describe("encodeSs58", () => {
  it("encodes the well-known dev accounts (format 42)", () => {
    // Alice / Bob — the canonical Substrate dev-account vectors.
    expect(
      encodeSs58(hex("0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d")),
    ).toBe("5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY");
    expect(
      encodeSs58(hex("0x8eaf04151687736326c9fea17e25fc5287613693c912909cb226aa4794f26a48")),
    ).toBe("5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty");
  });
  it("honours a non-default network format byte", () => {
    // format 0 (Polkadot) for Alice's key starts with '1'.
    expect(
      encodeSs58(hex("0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d"), 0),
    ).toBe("15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5");
  });
  it("returns null for non-32-byte input", () => {
    expect(encodeSs58(new Uint8Array(31))).toBeNull();
    expect(encodeSs58(new Uint8Array(33))).toBeNull();
  });
});

describe("base58Decode", () => {
  it("inverts base58Encode, including leading-zero '1's", () => {
    const bytes = hex("0x0000287fb4cd");
    expect(base58Decode(base58Encode(bytes))).toEqual(bytes);
  });
  it("returns null for a character outside the alphabet", () => {
    // '0', 'O', 'I', 'l' are excluded from the base58 alphabet.
    expect(base58Decode("0OIl")).toBeNull();
  });
});

describe("decodeSs58", () => {
  const alicePubkey = hex("0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d");

  it("decodes a format-42 address back to its pubkey, checksum-verified", () => {
    const decoded = decodeSs58("5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY");
    expect(decoded).toEqual({
      valid: true,
      format: 42,
      pubkey: alicePubkey,
      checksumValid: true,
      extendedFormat: false,
    });
  });

  it("decodes a different network format byte (0 = Polkadot)", () => {
    const decoded = decodeSs58("15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5");
    expect(decoded?.format).toBe(0);
    expect(decoded?.pubkey).toEqual(alicePubkey);
    expect(decoded?.checksumValid).toBe(true);
  });

  it("flags a corrupted checksum without throwing", () => {
    // Flip the last character of an otherwise-valid address.
    const valid = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
    const corrupted = valid.slice(0, -1) + (valid.endsWith("Y") ? "X" : "Y");
    const decoded = decodeSs58(corrupted);
    expect(decoded?.valid).toBe(false);
    expect(decoded?.checksumValid).toBe(false);
    expect(decoded?.pubkey).toBeNull();
  });

  it("returns null for malformed base58 input", () => {
    expect(decodeSs58("not-valid-base58-0OIl")).toBeNull();
  });

  it("returns null for a well-formed but wrong-length base58 string", () => {
    expect(decodeSs58(base58Encode(new Uint8Array(10)))).toBeNull();
  });

  it("round-trips encodeSs58 output for an arbitrary format byte", () => {
    const encoded = encodeSs58(alicePubkey, 2); // Kusama
    const decoded = decodeSs58(encoded!);
    expect(decoded).toEqual({
      valid: true,
      format: 2,
      pubkey: alicePubkey,
      checksumValid: true,
      extendedFormat: false,
    });
  });
});
