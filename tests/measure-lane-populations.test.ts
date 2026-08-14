// The Alpha key decoder, which was wrong once and did not error (#11206).
//
// Substrate key layouts are positional, so a wrong offset does not throw -- it
// returns a plausible value. Reading `netuid` at a hashed offset made every
// entry decode as 0, which reported the whole map as root and would have
// anchored a population constant on it.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { decodeAlphaKey } from "../scripts/measure-lane-populations.ts";

/** A real key from SubtensorModule::Alpha, 130 bytes: 32 prefix +
 * blake2_128_concat(hotkey) 16+32 + blake2_128_concat(coldkey) 16+32 +
 * netuid 2, the last IDENTITY-hashed. */
function alphaKey(hotkey: string, coldkey: string, netuid: number): string {
  const netuidLe = Buffer.alloc(2);
  netuidLe.writeUInt16LE(netuid);
  return (
    "0x" +
    "aa".repeat(32) + // module + storage prefix
    "bb".repeat(16) + // blake2_128(hotkey)
    hotkey +
    "cc".repeat(16) + // blake2_128(coldkey)
    coldkey +
    netuidLe.toString("hex")
  );
}

describe("decodeAlphaKey", () => {
  const HOT = "11".repeat(32);
  const COLD = "22".repeat(32);

  test("reads hotkey, coldkey and netuid from their real offsets", () => {
    assert.deepEqual(decodeAlphaKey(alphaKey(HOT, COLD, 128)), {
      hotkey: HOT,
      coldkey: COLD,
      netuid: 128,
    });
  });

  test("netuid is little-endian and root is distinguishable", () => {
    // The failure that mattered: everything decoding as 0 looks like a map
    // entirely on root, which is exactly what a wrong offset produced.
    assert.equal(decodeAlphaKey(alphaKey(HOT, COLD, 0)).netuid, 0);
    assert.equal(decodeAlphaKey(alphaKey(HOT, COLD, 1)).netuid, 1);
    assert.equal(decodeAlphaKey(alphaKey(HOT, COLD, 258)).netuid, 258);
  });

  test("the key is the expected length, so an offset cannot silently run past", () => {
    // 130 bytes = 260 hex + "0x". A layout change shows up here rather than as
    // a netuid read off the end, which yields 0 and reads as root.
    assert.equal(alphaKey(HOT, COLD, 7).length, 262);
  });

  test("hotkey and coldkey do not alias each other", () => {
    const decoded = decodeAlphaKey(alphaKey(HOT, COLD, 3));
    assert.notEqual(decoded.hotkey, decoded.coldkey);
  });
});
