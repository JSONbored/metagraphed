import { describe, it, expect } from "vitest";
import { unwrapByteArray, bytesToHex, decodeBytesField } from "./bytes";

describe("unwrapByteArray", () => {
  it("returns a flat byte array unchanged (zero wraps, e.g. Multisig's raw call_hash)", () => {
    const bytes = [55, 179, 165, 105];
    expect(unwrapByteArray(bytes)).toEqual(bytes);
  });

  it("unwraps one newtype layer (real SubtensorModule.commit_weights commit_hash, block 8587046/19)", () => {
    const bytes = [59, 140, 220, 127, 37, 107, 167, 77];
    expect(unwrapByteArray([bytes])).toEqual(bytes);
  });

  it("unwraps a variable-length newtype-wrapped blob (real commit_timelocked_weights commit field shape)", () => {
    const bytes = [134, 255, 107, 242, 50, 150];
    expect(unwrapByteArray([bytes])).toEqual(bytes);
  });

  it("unwraps two newtype layers", () => {
    const bytes = [1, 2, 3];
    expect(unwrapByteArray([[bytes]])).toEqual(bytes);
  });

  it("does not loop on a single-element array whose element is a plain scalar, not another array", () => {
    // Distinguishes a length-1 flat byte array ([5], a single-byte value)
    // from a length-1 array WRAPPING another array ([[5]], a newtype wrap) --
    // the while-loop's array-of-array check must stop here, not recurse
    // into the scalar.
    expect(unwrapByteArray([5])).toEqual([5]);
  });

  it("returns null for a non-byte-array value", () => {
    expect(unwrapByteArray("not an array")).toBeNull();
    expect(unwrapByteArray(null)).toBeNull();
    expect(unwrapByteArray(undefined)).toBeNull();
    expect(unwrapByteArray(42)).toBeNull();
    expect(unwrapByteArray({ a: 1 })).toBeNull();
  });

  it("returns null for an array containing a non-integer or out-of-range value", () => {
    expect(unwrapByteArray([1, 2, "3"])).toBeNull();
    expect(unwrapByteArray([1, 2, 256])).toBeNull();
    expect(unwrapByteArray([1, 2, -1])).toBeNull();
    expect(unwrapByteArray([1, 2.5, 3])).toBeNull();
  });

  it("returns null for a multi-element array wrapping arrays (not a single-element newtype wrap)", () => {
    expect(
      unwrapByteArray([
        [1, 2],
        [3, 4],
      ]),
    ).toBeNull();
  });

  it("returns an empty array for an empty flat array (vacuously a valid byte array)", () => {
    expect(unwrapByteArray([])).toEqual([]);
  });
});

describe("bytesToHex", () => {
  it("hex-encodes bytes matching D1's convention (real SubtensorModule.register work, block 8556317/20)", () => {
    const bytes = [0x10, 0x40, 0x70, 0x6a, 0x68, 0x9d, 0x63, 0x7b];
    expect(bytesToHex(bytes)).toBe("0x1040706a689d637b");
  });

  it("pads single-digit hex values", () => {
    expect(bytesToHex([0, 1, 15, 16])).toBe("0x00010f10");
  });

  it("returns 0x for an empty array", () => {
    expect(bytesToHex([])).toBe("0x");
  });
});

describe("decodeBytesField", () => {
  it("UTF-8-decodes System.remark_with_event's remark field (real data, block 8512299/12: D1 = 'module-test-5f758613')", () => {
    const text = "module-test-5f758613";
    const bytes = Array.from(new TextEncoder().encode(text));
    expect(decodeBytesField("System", "remark_with_event", "remark", bytes)).toBe(text);
  });

  it("UTF-8-decodes System.remark's remark field the same way", () => {
    const bytes = Array.from(new TextEncoder().encode("hello"));
    expect(decodeBytesField("System", "remark", "remark", bytes)).toBe("hello");
  });

  it("hex-encodes Ethereum.transact's input field -- deliberately NOT reproducing D1's UTF-8/Latin1 mojibake bug (real bytes, block 8587453/9)", () => {
    const bytes = [97, 70, 25, 84];
    const decoded = decodeBytesField("Ethereum", "transact", "input", bytes);
    expect(decoded).toBe("0x61461954");
    // D1's current (buggy) behavior force-decodes these same bytes as
    // UTF-8/Latin1, embedding an unprintable control character in the
    // rendered string. Confirm this decoder's output has no such character.
    const hasControlChar = Array.from(decoded).some((ch) => ch.charCodeAt(0) < 0x20);
    expect(hasControlChar).toBe(false);
  });

  it("hex-encodes opaque payload fields not on the textual allowlist (work, ciphertext, commit)", () => {
    const bytes = [16, 64, 112, 106];
    expect(decodeBytesField("SubtensorModule", "register", "work", bytes)).toBe(bytesToHex(bytes));
    expect(decodeBytesField("MevShield", "submit_encrypted", "ciphertext", bytes)).toBe(
      bytesToHex(bytes),
    );
    expect(decodeBytesField("SubtensorModule", "commit_timelocked_weights", "commit", bytes)).toBe(
      bytesToHex(bytes),
    );
  });

  it("falls back to hex when a field on the textual allowlist happens to contain invalid UTF-8", () => {
    const invalidUtf8 = [0xff, 0xfe, 0xfd];
    expect(decodeBytesField("System", "remark", "remark", invalidUtf8)).toBe(
      bytesToHex(invalidUtf8),
    );
  });

  it("hex-encodes a remark-named field on an unrelated call_module/call_function (allowlist is keyed on the full triple)", () => {
    const bytes = Array.from(new TextEncoder().encode("hello"));
    expect(decodeBytesField("SomeOtherModule", "some_function", "remark", bytes)).toBe(
      bytesToHex(bytes),
    );
  });

  it("handles null/undefined callModule or callFunction without throwing", () => {
    const bytes = [1, 2, 3];
    expect(decodeBytesField(null, null, "remark", bytes)).toBe(bytesToHex(bytes));
    expect(decodeBytesField(undefined, undefined, "input", bytes)).toBe(bytesToHex(bytes));
  });
});
