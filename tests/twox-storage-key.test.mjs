import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  xxh64,
  twox64,
  twox128,
  storageMapPrefix,
  twox64Concat,
  u16LeBytes,
  u32LeBytes,
  twox64ConcatU16StorageKey,
  twox64ConcatU32StorageKey,
  bytesToHex,
} from "../src/twox-storage-key.ts";

// Official xxHash64 reference vectors (seed=0), from the upstream xxHash
// test suite -- verifies the algorithm itself, independent of any
// Substrate-specific value.
describe("xxh64 against official reference vectors", () => {
  const vectors = [
    ["", 0n, 0xef46db3751d8e999n],
    ["a", 0n, 0xd24ec4f1a98c6e5bn],
    ["as", 0n, 0x1c330fb2d66be179n],
    ["asd", 0n, 0x631c37ce72a97393n],
    ["asdf", 0n, 0x415872f599cea71en],
  ];
  for (const [input, seed, expected] of vectors) {
    test(`xxh64(${JSON.stringify(input)}, seed=${seed}) === 0x${expected.toString(16)}`, () => {
      assert.equal(xxh64(input, seed), expected);
    });
  }
});

// >=32-byte inputs exercise the 4-lane path (short inputs above only cover
// the <32-byte path). Golden values cross-checked against Python's `xxhash`
// library (byte-exact match, seeds 0 and 1) since no short official test
// vector covers this branch.
describe("xxh64 4-lane path (inputs >= 32 bytes)", () => {
  const vectors = [
    ["a".repeat(32), 0n, 0x856e843298f99ad7n],
    ["a".repeat(32), 1n, 0x53ac5803e608ddf7n],
    ["a".repeat(33), 0n, 0x18f3ff0c21e3b24bn],
    ["a".repeat(33), 1n, 0x367f51444cb4aee7n],
    [
      "The quick brown fox jumps over the lazy dog, twice for good measure!",
      0n,
      0xb5d04541134228f5n,
    ],
  ];
  for (const [input, seed, expected] of vectors) {
    test(`xxh64(${JSON.stringify(input.slice(0, 20))}..., seed=${seed})`, () => {
      assert.equal(xxh64(input, seed), expected);
    });
  }
});

describe("twox128 against the codebase's own proven-correct reference", () => {
  test('twox128("Sudo") ++ twox128("Key") matches sudo-key.ts\'s hardcoded SUDO_KEY_STORAGE_KEY', () => {
    const key = bytesToHex(
      new Uint8Array([...twox128("Sudo"), ...twox128("Key")]),
    );
    assert.equal(
      key,
      "0x5c0d1176a568c1f92944340dbfed9e9c530ebca703c85910e7164cb7d1c9e47b",
    );
  });

  test('storageMapPrefix("SubtensorModule", "Burn") matches subnet-burn.ts\'s hardcoded prefix', () => {
    // subnet-burn.ts's GOLDEN_STORAGE_KEY is
    // 0x658faa385070e074c85bf6b568cf0555...01be1755d08418802946bca51b6863250100
    // -- the full 32-byte prefix is twox128("SubtensorModule") ++ twox128("Burn").
    const prefix = bytesToHex(storageMapPrefix("SubtensorModule", "Burn"));
    assert.equal(
      prefix,
      "0x658faa385070e074c85bf6b568cf055501be1755d08418802946bca51b686325",
    );
  });
});

describe("twox64 / twox64Concat", () => {
  test("twox64 is 8 bytes", () => {
    assert.equal(twox64("anything").length, 8);
  });

  test("twox64Concat appends the raw key bytes after the 8-byte hash", () => {
    const key = new Uint8Array([1, 2, 3]);
    const result = twox64Concat(key);
    assert.equal(result.length, 11);
    assert.deepEqual(result.slice(8), key);
  });
});

describe("u16LeBytes / u32LeBytes SCALE encoding", () => {
  test("u16LeBytes is little-endian, 2 bytes", () => {
    assert.deepEqual(u16LeBytes(1), new Uint8Array([1, 0]));
    assert.deepEqual(u16LeBytes(45), new Uint8Array([0x2d, 0]));
    assert.deepEqual(u16LeBytes(65535), new Uint8Array([0xff, 0xff]));
  });

  test("u32LeBytes is little-endian, 4 bytes", () => {
    assert.deepEqual(u32LeBytes(7), new Uint8Array([7, 0, 0, 0]));
    assert.deepEqual(
      u32LeBytes(4294967295),
      new Uint8Array([0xff, 0xff, 0xff, 0xff]),
    );
  });
});

// Full storage-key golden values, independently cross-checked against
// Python's `xxhash` library computing the same twox128/twox64Concat
// derivation (see scratchpad compute_lease_keys.py from the #6719
// investigation). The SubtensorModule prefix segment
// (658faa385070e074c85bf6b568cf055) matches subnet-burn.ts's own
// hardcoded, already-production-verified prefix.
describe("twox64ConcatU16StorageKey (SubnetUidToLeaseId)", () => {
  const cases = [
    [
      1,
      "0x658faa385070e074c85bf6b568cf05550a7808992d927def294f80ab9d5e0b48f1577fbf1d628fdd0100",
    ],
    [
      0,
      "0x658faa385070e074c85bf6b568cf05550a7808992d927def294f80ab9d5e0b4801a12dfa1fa4ab9a0000",
    ],
    [
      45,
      "0x658faa385070e074c85bf6b568cf05550a7808992d927def294f80ab9d5e0b48a9e62c397d2b48482d00",
    ],
    [
      65535,
      "0x658faa385070e074c85bf6b568cf05550a7808992d927def294f80ab9d5e0b488d3e46a2f8c36954ffff",
    ],
  ];
  for (const [netuid, expected] of cases) {
    test(`netuid=${netuid}`, () => {
      assert.equal(
        twox64ConcatU16StorageKey(
          "SubtensorModule",
          "SubnetUidToLeaseId",
          netuid,
        ),
        expected,
      );
    });
  }

  test("key ends with the raw little-endian netuid bytes (Twox64Concat, not plain Twox64)", () => {
    const key = twox64ConcatU16StorageKey(
      "SubtensorModule",
      "SubnetUidToLeaseId",
      45,
    );
    assert.ok(key.endsWith("2d00"));
  });
});

// LeaseId is a Substrate u32 (pallets/subtensor/src/subnets/leasing.rs:31:
// `pub type LeaseId = u32;`), NOT u64 -- confirmed against the pallet's own
// #[pallet::storage] declarations (SubnetLeases / AccumulatedLeaseDividends
// are both `StorageMap<_, Twox64Concat, LeaseId, ...>`). Golden values cross-
// checked against Python's `xxhash` library independently of this module.
describe("twox64ConcatU32StorageKey (SubnetLeases / AccumulatedLeaseDividends)", () => {
  test("SubnetLeases(7)", () => {
    assert.equal(
      twox64ConcatU32StorageKey("SubtensorModule", "SubnetLeases", 7),
      "0x658faa385070e074c85bf6b568cf0555c4625eddace838acd0d3d18f837717310e0d969b0e48cab707000000",
    );
  });

  test("AccumulatedLeaseDividends(0)", () => {
    assert.equal(
      twox64ConcatU32StorageKey(
        "SubtensorModule",
        "AccumulatedLeaseDividends",
        0,
      ),
      "0x658faa385070e074c85bf6b568cf0555a007e52dfb6300823ddc03782fb1fd58b4def25cfda6ef3a00000000",
    );
  });

  test("AccumulatedLeaseDividends(4294967295) -- max u32 lease id", () => {
    assert.equal(
      twox64ConcatU32StorageKey(
        "SubtensorModule",
        "AccumulatedLeaseDividends",
        4294967295,
      ),
      "0x658faa385070e074c85bf6b568cf0555a007e52dfb6300823ddc03782fb1fd5893dfada3bde4787fffffffff",
    );
  });
});
