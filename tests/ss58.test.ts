import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  DEFAULT_SS58_PREFIX,
  decodeSs58,
  encodeAccountId32,
  normalizeAccountId32Field,
  unwrapMultiAddressId,
} from "../src/ss58.ts";

// Carried over from tests/sudo-key.test.mjs -- live-confirmed 2026-07-08
// against finney (bittensor 10.5.0, substrate.create_storage_key("Sudo",
// "Key") + a raw state_getStorage RPC call).
const GOLDEN_RAW_STORAGE =
  "0x4471816662ea3cfadc9868e5f083e26a3be6706b8d8dad7fbef565983afb3556";
const GOLDEN_SS58 = "5DcSqBNqCmfdJZRGFSwwcRb2dZdJHZuKK8Tb1Gx8gbmF5E8s";

function hexToBytes(hex: string) {
  const clean = hex.slice(2);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1)
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

// Real production data (2026-07-09/10 D1-vs-Postgres shape-parity audit,
// #4669/#4688): SubtensorModule.add_stake, block 8587451, extrinsic_index 20.
// Independently re-confirmed live against Postgres (D1 has since rolled this
// block out of its retention window) and cross-checked byte-for-byte against
// the SS58 string D1 served for the same extrinsic before this fix landed.
const ADD_STAKE_HOTKEY_BYTES = [
  218, 242, 207, 184, 146, 103, 37, 85, 165, 200, 187, 85, 14, 162, 252, 59, 70,
  104, 173, 244, 214, 178, 164, 112, 5, 200, 46, 53, 22, 206, 26, 85,
];
const ADD_STAKE_HOTKEY_SS58 =
  "5H1nRfbCbDGh3t17er9Y8hwFEsXCrjBbaN6jLrnez8KpUKju";

// Balances.transfer_all, block 8587450, extrinsic_index 20 -- the
// MultiAddress::Id(AccountId32) shape (Balances/Proxy/Contracts dest fields).
const TRANSFER_ALL_DEST_BYTES = [
  148, 23, 68, 122, 121, 209, 249, 231, 72, 77, 75, 123, 3, 244, 110, 63, 98,
  234, 211, 56, 18, 215, 171, 86, 162, 59, 211, 147, 124, 3, 247, 30,
];
const TRANSFER_ALL_DEST_SS58 =
  "5FQsrbnp2dEvemXG41JmjnrsSaSQyfGAoe5hK3EHBhu8Z1sT";

describe("encodeAccountId32", () => {
  test("encodes the golden Sudo::Key raw storage bytes to its known SS58 address", () => {
    assert.equal(
      encodeAccountId32(hexToBytes(GOLDEN_RAW_STORAGE)),
      GOLDEN_SS58,
    );
  });

  test("encodes the real add_stake hotkey bytes to its known SS58 address", () => {
    assert.equal(
      encodeAccountId32(ADD_STAKE_HOTKEY_BYTES),
      ADD_STAKE_HOTKEY_SS58,
    );
  });

  test("accepts a plain array or a Uint8Array identically", () => {
    assert.equal(
      encodeAccountId32(ADD_STAKE_HOTKEY_BYTES),
      encodeAccountId32(Uint8Array.from(ADD_STAKE_HOTKEY_BYTES)),
    );
  });

  test("defaults to the generic-Substrate/Bittensor prefix (42)", () => {
    assert.equal(DEFAULT_SS58_PREFIX, 42);
  });

  test("returns null for a non-32-byte input", () => {
    assert.equal(encodeAccountId32([1, 2, 3]), null);
    assert.equal(encodeAccountId32(new Array(31).fill(0)), null);
    assert.equal(encodeAccountId32(new Array(33).fill(0)), null);
  });
});

describe("decodeSs58", () => {
  test("decodes the golden Sudo::Key SS58 address back to its known raw bytes", () => {
    const decoded = decodeSs58(GOLDEN_SS58);
    assert.equal(decoded!.prefix, DEFAULT_SS58_PREFIX);
    assert.deepEqual(
      [...decoded!.publicKey],
      [...hexToBytes(GOLDEN_RAW_STORAGE)],
    );
  });

  test("decodes the real add_stake hotkey SS58 address back to its known raw bytes", () => {
    const decoded = decodeSs58(ADD_STAKE_HOTKEY_SS58);
    assert.equal(decoded!.prefix, DEFAULT_SS58_PREFIX);
    assert.deepEqual([...decoded!.publicKey], ADD_STAKE_HOTKEY_BYTES);
  });

  test("round-trips arbitrary bytes through encodeAccountId32 -> decodeSs58", () => {
    const bytes = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256);
    const address = encodeAccountId32(bytes);
    const decoded = decodeSs58(address);
    assert.equal(decoded!.prefix, DEFAULT_SS58_PREFIX);
    assert.deepEqual([...decoded!.publicKey], [...bytes]);
  });

  test("returns null for a bad checksum (single flipped character)", () => {
    const flipped =
      GOLDEN_SS58.slice(0, -1) + (GOLDEN_SS58.at(-1) === "E" ? "F" : "E");
    assert.equal(decodeSs58(flipped), null);
  });

  test("returns null for a character outside the base58 alphabet", () => {
    assert.equal(decodeSs58(`0${GOLDEN_SS58.slice(1)}`), null);
    assert.equal(decodeSs58(`I${GOLDEN_SS58.slice(1)}`), null);
  });

  test("returns null for malformed/non-string input", () => {
    assert.equal(decodeSs58(""), null);
    assert.equal(decodeSs58(null), null);
    assert.equal(decodeSs58(undefined), null);
    assert.equal(decodeSs58(42), null);
    assert.equal(decodeSs58("too-short"), null);
    assert.equal(decodeSs58(`${GOLDEN_SS58}${GOLDEN_SS58}`), null);
  });
});

describe("unwrapMultiAddressId", () => {
  test("unwraps the Id variant to its raw 32 bytes", () => {
    assert.deepEqual(
      unwrapMultiAddressId({ name: "Id", values: [[TRANSFER_ALL_DEST_BYTES]] }),
      TRANSFER_ALL_DEST_BYTES,
    );
  });

  test("returns null for the Index/Raw/Address32/Address20 variants (not observed on this chain, decline rather than guess)", () => {
    assert.equal(unwrapMultiAddressId({ name: "Index", values: [5] }), null);
    assert.equal(
      unwrapMultiAddressId({ name: "Raw", values: [[1, 2, 3]] }),
      null,
    );
    assert.equal(
      unwrapMultiAddressId({
        name: "Address32",
        values: [[new Array(32).fill(1)]],
      }),
      null,
    );
    assert.equal(
      unwrapMultiAddressId({
        name: "Address20",
        values: [[new Array(20).fill(1)]],
      }),
      null,
    );
  });

  test("returns null for non-enum-shaped input", () => {
    assert.equal(unwrapMultiAddressId(null), null);
    assert.equal(unwrapMultiAddressId(undefined), null);
    assert.equal(unwrapMultiAddressId(TRANSFER_ALL_DEST_BYTES), null);
    assert.equal(unwrapMultiAddressId({ name: "Id" }), null);
    assert.equal(unwrapMultiAddressId({ name: "Id", values: [] }), null);
    assert.equal(unwrapMultiAddressId({ name: "Id", values: [1, 2] }), null);
  });
});

describe("normalizeAccountId32Field", () => {
  test("resolves the newtype-wrapped bare AccountId32 shape (hotkey/coldkey/etc.)", () => {
    assert.equal(
      normalizeAccountId32Field([ADD_STAKE_HOTKEY_BYTES]),
      ADD_STAKE_HOTKEY_SS58,
    );
  });

  test("resolves a flat 32-byte array the same way", () => {
    assert.equal(
      normalizeAccountId32Field(ADD_STAKE_HOTKEY_BYTES),
      ADD_STAKE_HOTKEY_SS58,
    );
  });

  test("resolves the MultiAddress::Id wrapper", () => {
    assert.equal(
      normalizeAccountId32Field({
        name: "Id",
        values: [[TRANSFER_ALL_DEST_BYTES]],
      }),
      TRANSFER_ALL_DEST_SS58,
    );
  });

  test("returns null for a shape that doesn't resolve to 32 bytes", () => {
    assert.equal(
      normalizeAccountId32Field({ name: "Index", values: [5] }),
      null,
    );
    assert.equal(normalizeAccountId32Field([1, 2, 3]), null);
    assert.equal(normalizeAccountId32Field(null), null);
    assert.equal(normalizeAccountId32Field(42), null);
  });
});
