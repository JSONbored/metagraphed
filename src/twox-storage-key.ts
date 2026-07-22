// Substrate Twox64/Twox128 storage-key derivation (#6719). Every hardcoded
// storage key elsewhere in this codebase (sudo-key.mjs, network-parameters.ts,
// subnet-burn.ts, subnet-recycled.mjs) is a FIXED string precomputed offline
// specifically because those pallet/item name prefixes never change and
// twox128 needs XXHash64, not in Node's built-in crypto -- this module exists
// because subnet leasing's storage maps (#6719) are Twox64Concat-hashed on
// the MAP KEY itself (netuid, lease_id), which varies per request and so
// can't be precomputed the same way. XXH64 implemented directly rather than
// adding a new npm dependency, matching this codebase's existing "implement
// the small crypto primitive by hand for Workers" convention (ss58.mjs's own
// header comment on why @noble/hashes' blake2b is required over Node's
// built-in createHash: same reasoning, different primitive).
//
// Verified against BOTH the official xxHash reference test vectors AND this
// codebase's own already-proven-correct sudo-key.mjs storage key (twox128("Sudo")
// ++ twox128("Key") = 0x5c0d1176a568c1f92944340dbfed9e9c530ebca703c85910e7164cb7d1c9e47b) --
// see tests/twox-storage-key.test.mjs.

const PRIME64_1 = 0x9e3779b185ebca87n;
const PRIME64_2 = 0xc2b2ae3d27d4eb4fn;
const PRIME64_3 = 0x165667b19e3779f9n;
const PRIME64_4 = 0x85ebca77c2b2ae63n;
const PRIME64_5 = 0x27d4eb2f165667c5n;
const MASK64 = (1n << 64n) - 1n;

function rotl64(x: bigint, r: bigint): bigint {
  x &= MASK64;
  return ((x << r) | (x >> (64n - r))) & MASK64;
}

function readU64LE(bytes: Uint8Array, offset: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i -= 1) {
    v = (v << 8n) | BigInt(bytes[offset + i]);
  }
  return v;
}

function readU32LE(bytes: Uint8Array, offset: number): bigint {
  return (
    BigInt(bytes[offset]) |
    (BigInt(bytes[offset + 1]) << 8n) |
    (BigInt(bytes[offset + 2]) << 16n) |
    (BigInt(bytes[offset + 3]) << 24n)
  );
}

// Full XXH64 algorithm (both the >=32-byte 4-lane path and the short-input
// path) -- every actual call site in this codebase hashes a short pallet/item
// name or a 2-8 byte SCALE-encoded map key, well under 32 bytes, but the long
// path is implemented too rather than asserting a length ceiling, so this
// stays correct if a future storage item's key ever needs it.
export function xxh64(input: Uint8Array | string, seed = 0n): bigint {
  const bytes =
    input instanceof Uint8Array ? input : new TextEncoder().encode(input);
  const len = bytes.length;
  let h64;
  let offset = 0;

  if (len >= 32) {
    let v1 = (seed + PRIME64_1 + PRIME64_2) & MASK64;
    let v2 = (seed + PRIME64_2) & MASK64;
    let v3 = seed & MASK64;
    let v4 = (seed - PRIME64_1) & MASK64;
    const limit = len - 32;
    while (offset <= limit) {
      v1 =
        (rotl64((v1 + readU64LE(bytes, offset) * PRIME64_2) & MASK64, 31n) *
          PRIME64_1) &
        MASK64;
      v2 =
        (rotl64((v2 + readU64LE(bytes, offset + 8) * PRIME64_2) & MASK64, 31n) *
          PRIME64_1) &
        MASK64;
      v3 =
        (rotl64(
          (v3 + readU64LE(bytes, offset + 16) * PRIME64_2) & MASK64,
          31n,
        ) *
          PRIME64_1) &
        MASK64;
      v4 =
        (rotl64(
          (v4 + readU64LE(bytes, offset + 24) * PRIME64_2) & MASK64,
          31n,
        ) *
          PRIME64_1) &
        MASK64;
      offset += 32;
    }
    h64 =
      (rotl64(v1, 1n) + rotl64(v2, 7n) + rotl64(v3, 12n) + rotl64(v4, 18n)) &
      MASK64;

    for (const v of [v1, v2, v3, v4]) {
      const merged =
        (rotl64((v * PRIME64_2) & MASK64, 31n) * PRIME64_1) & MASK64;
      h64 = ((h64 ^ merged) * PRIME64_1 + PRIME64_4) & MASK64;
    }
  } else {
    h64 = (seed + PRIME64_5) & MASK64;
  }

  h64 = (h64 + BigInt(len)) & MASK64;

  while (offset + 8 <= len) {
    const k1 =
      (rotl64((readU64LE(bytes, offset) * PRIME64_2) & MASK64, 31n) *
        PRIME64_1) &
      MASK64;
    h64 = (rotl64((h64 ^ k1) & MASK64, 27n) * PRIME64_1 + PRIME64_4) & MASK64;
    offset += 8;
  }
  if (offset + 4 <= len) {
    h64 =
      (rotl64((h64 ^ (readU32LE(bytes, offset) * PRIME64_1)) & MASK64, 23n) *
        PRIME64_2 +
        PRIME64_3) &
      MASK64;
    offset += 4;
  }
  while (offset < len) {
    h64 =
      (rotl64((h64 ^ (BigInt(bytes[offset]) * PRIME64_5)) & MASK64, 11n) *
        PRIME64_1) &
      MASK64;
    offset += 1;
  }

  h64 ^= h64 >> 33n;
  h64 = (h64 * PRIME64_2) & MASK64;
  h64 ^= h64 >> 29n;
  h64 = (h64 * PRIME64_3) & MASK64;
  h64 ^= h64 >> 32n;
  return h64 & MASK64;
}

function u64ToLeBytes(v: bigint): Uint8Array {
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i += 1) {
    out[i] = Number((v >> BigInt(i * 8)) & 0xffn);
  }
  return out;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// twox64(input) -- one XXH64 hash (seed 0), little-endian bytes. This IS the
// Twox64Concat map-key hash (not "prefix"); see twox64Concat below for the
// full concat form actually used in a StorageMap key.
export function twox64(input: Uint8Array | string): Uint8Array {
  return u64ToLeBytes(xxh64(input, 0n));
}

// twox128(input) -- the fixed pallet-name/item-name prefix hash: two XXH64
// hashes (seeds 0 and 1) concatenated, little-endian. Matches sudo-key.mjs's
// own already-verified reference value exactly (see this module's header).
export function twox128(input: Uint8Array | string): Uint8Array {
  return concatBytes(
    u64ToLeBytes(xxh64(input, 0n)),
    u64ToLeBytes(xxh64(input, 1n)),
  );
}

// The fixed prefix for a whole storage item: twox128(pallet) ++ twox128(item).
// Same shape as every hardcoded *_STORAGE_KEY_PREFIX constant elsewhere in
// this codebase, just computed at runtime instead of hardcoded -- since this
// module exists specifically for storage items whose full key ALSO needs a
// per-request Twox64Concat suffix, precomputing just the prefix independently
// saves nothing (the pallet+item strings are already known constants either
// way), so both are exposed for callers to compose as needed.
export function storageMapPrefix(
  palletName: string,
  itemName: string,
): Uint8Array {
  return concatBytes(twox128(palletName), twox128(itemName));
}

// Twox64Concat map-key suffix: hash(key) ++ key (the raw, un-hashed key bytes
// follow the hash -- this is what makes state_getKeysPaged enumeration able
// to recover the original key by reading the tail of each returned storage
// key, unlike a Blake2_128Concat-hashed key of variable/opaque original width
// stored the same way but requiring a different hash-length skip).
export function twox64Concat(keyBytes: Uint8Array): Uint8Array {
  return concatBytes(twox64(keyBytes), keyBytes);
}

// u16 SCALE encoding: little-endian, 2 bytes. Same convention as subnet-
// burn.mjs's own netuidStorageKeySuffix, duplicated rather than imported
// (this codebase's established self-contained-module convention for small
// codec helpers -- see subnet-burn.ts's own comment on why).
export function u16LeBytes(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >> 8) & 0xff]);
}

// Full storage key for a StorageMap<_, Twox64Concat, u16, V> entry (e.g.
// SubtensorModule::SubnetUidToLeaseId), as a "0x"-prefixed hex string ready
// for a state_getStorage RPC call.
export function twox64ConcatU16StorageKey(
  palletName: string,
  itemName: string,
  netuid: number,
): string {
  const prefix = storageMapPrefix(palletName, itemName);
  const suffix = twox64Concat(u16LeBytes(netuid));
  return "0x" + toHex(concatBytes(prefix, suffix));
}

// u32 SCALE encoding: little-endian, 4 bytes -- Substrate's `LeaseId = u32`
// (pallets/subtensor/src/subnets/leasing.rs), the map key for SubnetLeases
// and AccumulatedLeaseDividends.
export function u32LeBytes(n: number): Uint8Array {
  return new Uint8Array([
    n & 0xff,
    (n >> 8) & 0xff,
    (n >> 16) & 0xff,
    (n >> 24) & 0xff,
  ]);
}

export function twox64ConcatU32StorageKey(
  palletName: string,
  itemName: string,
  id: number,
): string {
  const prefix = storageMapPrefix(palletName, itemName);
  const suffix = twox64Concat(u32LeBytes(id));
  return "0x" + toHex(concatBytes(prefix, suffix));
}

export function bytesToHex(bytes: Uint8Array): string {
  return "0x" + toHex(bytes);
}
