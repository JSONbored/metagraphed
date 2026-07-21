import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { unwrapByteArray, bytesToHex, decodeBytesField } from "../src/bytes.ts";

describe("unwrapByteArray", () => {
  test("returns a flat byte array unchanged (zero wraps, e.g. Multisig's raw call_hash)", () => {
    const bytes = [55, 179, 165, 105];
    assert.deepEqual(unwrapByteArray(bytes), bytes);
  });

  test("unwraps one newtype layer (real SubtensorModule.commit_weights commit_hash, block 8587046/19)", () => {
    const bytes = [59, 140, 220, 127, 37, 107, 167, 77];
    assert.deepEqual(unwrapByteArray([bytes]), bytes);
  });

  test("unwraps two newtype layers", () => {
    const bytes = [1, 2, 3];
    assert.deepEqual(unwrapByteArray([[bytes]]), bytes);
  });

  test("does not loop on a single-element array whose element is a plain scalar, not another array", () => {
    // Distinguishes a length-1 flat byte array ([5], a single-byte value)
    // from a length-1 array WRAPPING another array ([[5]], a newtype wrap) --
    // the while-loop's array-of-array check must stop here, not recurse into
    // the scalar.
    assert.deepEqual(unwrapByteArray([5]), [5]);
  });

  test("returns null for a non-byte-array value", () => {
    assert.equal(unwrapByteArray("not an array"), null);
    assert.equal(unwrapByteArray(null), null);
    assert.equal(unwrapByteArray(undefined), null);
    assert.equal(unwrapByteArray(42), null);
    assert.equal(unwrapByteArray({ a: 1 }), null);
  });

  test("returns null for an array containing a non-integer or out-of-range value", () => {
    assert.equal(unwrapByteArray([1, 2, "3"]), null);
    assert.equal(unwrapByteArray([1, 2, 256]), null);
    assert.equal(unwrapByteArray([1, 2, -1]), null);
    assert.equal(unwrapByteArray([1, 2.5, 3]), null);
  });

  test("returns null for a multi-element array wrapping arrays (not a single-element newtype wrap)", () => {
    assert.equal(
      unwrapByteArray([
        [1, 2],
        [3, 4],
      ]),
      null,
    );
  });

  test("returns an empty array for an empty flat array (vacuously a valid byte array)", () => {
    assert.deepEqual(unwrapByteArray([]), []);
  });
});

describe("bytesToHex", () => {
  test("hex-encodes bytes matching D1's convention (real SubtensorModule.register work, block 8556317/20)", () => {
    const bytes = [0x10, 0x40, 0x70, 0x6a, 0x68, 0x9d, 0x63, 0x7b];
    assert.equal(bytesToHex(bytes), "0x1040706a689d637b");
  });

  test("pads single-digit hex values", () => {
    assert.equal(bytesToHex([0, 1, 15, 16]), "0x00010f10");
  });

  test("returns 0x for an empty array", () => {
    assert.equal(bytesToHex([]), "0x");
  });
});

describe("decodeBytesField", () => {
  test("UTF-8-decodes System.remark_with_event's remark field (real data, block 8512299/12: D1 = 'module-test-5f758613')", () => {
    const text = "module-test-5f758613";
    const bytes = Array.from(new TextEncoder().encode(text));
    assert.equal(
      decodeBytesField("System", "remark_with_event", "remark", bytes),
      text,
    );
  });

  test("UTF-8-decodes System.remark's remark field the same way", () => {
    const bytes = Array.from(new TextEncoder().encode("hello"));
    assert.equal(
      decodeBytesField("System", "remark", "remark", bytes),
      "hello",
    );
  });

  test("hex-encodes Ethereum.transact's input field -- deliberately NOT reproducing D1's UTF-8/Latin1 mojibake bug (real bytes, block 8587453/9)", () => {
    const bytes = [97, 70, 25, 84];
    const decoded = decodeBytesField("Ethereum", "transact", "input", bytes);
    assert.equal(decoded, "0x61461954");
    const hasControlChar = Array.from(decoded).some(
      (ch) => ch.charCodeAt(0) < 0x20,
    );
    assert.equal(hasControlChar, false);
  });

  test("hex-encodes opaque payload fields not on the textual allowlist (work, ciphertext, commit)", () => {
    const bytes = [16, 64, 112, 106];
    assert.equal(
      decodeBytesField("SubtensorModule", "register", "work", bytes),
      bytesToHex(bytes),
    );
    assert.equal(
      decodeBytesField("MevShield", "submit_encrypted", "ciphertext", bytes),
      bytesToHex(bytes),
    );
    assert.equal(
      decodeBytesField(
        "SubtensorModule",
        "commit_timelocked_weights",
        "commit",
        bytes,
      ),
      bytesToHex(bytes),
    );
  });

  test("falls back to hex when a field on the textual allowlist happens to contain invalid UTF-8", () => {
    const invalidUtf8 = [0xff, 0xfe, 0xfd];
    assert.equal(
      decodeBytesField("System", "remark", "remark", invalidUtf8),
      bytesToHex(invalidUtf8),
    );
  });

  test("hex-encodes a remark-named field on an unrelated call_module/call_function (allowlist is keyed on the full triple)", () => {
    const bytes = Array.from(new TextEncoder().encode("hello"));
    assert.equal(
      decodeBytesField("SomeOtherModule", "some_function", "remark", bytes),
      bytesToHex(bytes),
    );
  });

  test("handles null/undefined callModule or callFunction without throwing", () => {
    const bytes = [1, 2, 3];
    assert.equal(
      decodeBytesField(null, null, "remark", bytes),
      bytesToHex(bytes),
    );
    assert.equal(
      decodeBytesField(undefined, undefined, "input", bytes),
      bytesToHex(bytes),
    );
  });
});
