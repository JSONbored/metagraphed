// Live root-claim current-state for one coldkey (#7229, the read-only piece
// split out of the maintainer-only umbrella #7002): a coldkey's ROOT (netuid
// 0) stake earns dividends across every subnet its hotkey(s) validate in, and
// the root-claim system controls what happens to that alpha. This surfaces the
// current, pending state -- what's claimable now, the coldkey's claim-behavior
// setting, and the running cumulative already claimed -- read-only. No claim
// execution: this codebase never signs or submits transactions (the claim_root
// extrinsic is explicitly out of scope, same as the parent issue).
//
// Live-RPC + KV-cache route, same shape as src/subnet-lease.mjs / src/child-
// hotkey-delegation.mjs -- current chain state, not a historical event stream.
//
// Storage items (pallets/subtensor/src/lib.rs, fetched from opentensor/
// subtensor's own GitHub source 2026-07-20 for the authoritative hasher/type
// layout rather than guessing it):
//   RootClaimType:          StorageMap<_, Blake2_128Concat, AccountId (cold),
//                             RootClaimTypeEnum, ValueQuery, default Swap>
//   OwnedHotkeys:           StorageMap<_, Blake2_128Concat, AccountId (cold),
//                             Vec<AccountId>, ValueQuery, default []>
//   RootClaimable:          StorageMap<_, Blake2_128Concat, AccountId (hot),
//                             BTreeMap<NetUid, I96F32>, ValueQuery, default {}>
//   RootClaimableThreshold: StorageMap<_, Blake2_128Concat, NetUid, I96F32,
//                             ValueQuery, default DefaultMinRootClaimAmount>
//   RootClaimed:            StorageNMap<(Identity NetUid, Blake2_128Concat hot,
//                             Blake2_128Concat cold), u128, ValueQuery, default 0>
//
// RootClaimable is keyed by HOTKEY, but this route is coldkey-scoped (callers
// want "this coldkey's claimable dividends", the same posture as every other
// /accounts/{ss58}/* read). A coldkey controls several hotkeys, so the coldkey
// -> hotkeys resolution goes through OwnedHotkeys (the standard subtensor
// registry for exactly that), then each owned hotkey's RootClaimable is read,
// and for each (netuid, hotkey) claimable entry the cumulative RootClaimed and
// the per-subnet RootClaimableThreshold dust floor are looked up to build one
// enriched per-entry breakdown plus coldkey-level aggregates. The hotkey count
// is bounded (MAX_HOTKEYS) so a pathological account can't fan out unbounded
// subrequests; hotkeys_truncated flags when that bound was hit.
//
// RootClaimTypeEnum's #[derive(Encode, Decode)] variant order IS its SCALE
// discriminant order: Swap=0, Keep=1, KeepSubnets{subnets: BTreeSet<NetUid>}=2.
// I96F32 (substrate-fixed) is a signed 128-bit fixed-point value with 32
// fractional bits: 16 bytes, two's-complement little-endian, display = raw /
// 2^32 (surfaced as-is, not further unit-scaled). NetUid is a u16 (2 bytes LE).

import { blake2b } from "@noble/hashes/blake2.js";
import { encodeAccountId32 } from "./ss58.mjs";
import { isFinneySs58Address } from "./account-balance.mjs";
import {
  storageMapPrefix,
  bytesToHex,
  u16LeBytes,
} from "./twox-storage-key.mjs";

export const ROOT_CLAIM_KV_TTL = 120; // seconds -- live chain state, same profile as child-hotkey-delegation.mjs
export const ROOT_CLAIM_NEGATIVE_KV_TTL = 10; // seconds
export const ROOT_CLAIM_RPC_TIMEOUT_MS = 5000;
const FINNEY_RPC_URL = "https://entrypoint-finney.opentensor.ai:443";
// A coldkey controlling more than this many hotkeys is extraordinary; the
// bound keeps a pathological account from fanning out an unbounded number of
// per-hotkey RootClaimable subrequests. hotkeys_truncated surfaces when hit.
export const MAX_HOTKEYS = 128;
// DefaultMinRootClaimAmount = 500_000u64.into() (an I96F32 whole number), the
// ValueQuery default returned for a subnet whose RootClaimableThreshold was
// never explicitly set -- display value 500000.
export const DEFAULT_ROOT_CLAIM_THRESHOLD = 500000;

// Only ever called after isFinneySs58Address(ss58) has already proven `ss58`
// is a valid finney address decoding to exactly 35 bytes with a matching
// checksum, so no defensive re-checks here (this codebase's "don't validate
// twice" convention). Duplicates account-balance.mjs's base58 decode rather
// than importing it, the established self-contained-codec-helper convention.
function accountIdFromSs58(ss58) {
  const BASE58_ALPHABET =
    "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const INDEX = new Map([...BASE58_ALPHABET].map((c, i) => [c, i]));
  const bytes = [0];
  for (const char of ss58) {
    let carry = INDEX.get(char);
    for (let i = 0; i < bytes.length; i += 1) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const decoded = Uint8Array.from(bytes.reverse());
  return decoded.subarray(1, 33);
}

function blake2_128Concat(bytes) {
  const hash = blake2b(bytes, { dkLen: 16 });
  const out = new Uint8Array(hash.length + bytes.length);
  out.set(hash, 0);
  out.set(bytes, hash.length);
  return out;
}

function concatBytes(...parts) {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

// Full storage key for a single-Blake2_128Concat-keyed item (RootClaimType /
// OwnedHotkeys / RootClaimable, all keyed by one AccountId or NetUid), ready
// for state_getStorage.
function blake2ScopedKey(itemName, keyBytes) {
  return bytesToHex(
    concatBytes(
      storageMapPrefix("SubtensorModule", itemName),
      blake2_128Concat(keyBytes),
    ),
  );
}

// RootClaimed's StorageNMap key: prefix ++ Identity(netuid) ++
// Blake2_128Concat(hotkey) ++ Blake2_128Concat(coldkey). The Identity hasher
// leaves the raw 2-byte netuid unhashed.
function rootClaimedKey(netuid, hotkeyId, coldkeyId) {
  return bytesToHex(
    concatBytes(
      storageMapPrefix("SubtensorModule", "RootClaimed"),
      u16LeBytes(netuid),
      blake2_128Concat(hotkeyId),
      blake2_128Concat(coldkeyId),
    ),
  );
}

// One raw state_getStorage read. `ok` is false only on a genuine RPC failure
// (non-2xx / timeout / network error); `raw` is the JSON-RPC result on
// success, itself `null` for a genuinely-absent (ValueQuery-default) key.
async function fetchStorageRaw(storageKey, timeoutMs) {
  try {
    const rpcResp = await fetch(FINNEY_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "state_getStorage",
        params: [storageKey],
      }),
    });
    if (!rpcResp.ok) return { ok: false, raw: undefined };
    const rpcBody = await rpcResp.json();
    return { ok: true, raw: rpcBody?.result };
  } catch {
    return { ok: false, raw: undefined };
  }
}

// "0x"-prefixed even-length hex -> raw bytes. null on anything else.
function hexToBytes(hex) {
  if (typeof hex !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(hex)) {
    return null;
  }
  const body = hex.slice(2);
  const bytes = new Uint8Array(body.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function readU16LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU128LEBigInt(bytes, offset) {
  let value = 0n;
  for (let i = 15; i >= 0; i -= 1) {
    value = (value << 8n) | BigInt(bytes[offset + i]);
  }
  return value;
}

// SCALE Compact<u32> at `offset`. Returns { value, nextOffset } or null on a
// malformed/unsupported encoding. Modes 0/1/2 (single/two/four-byte) cover
// every realistic collection length here; mode 3 (big-integer) is treated as a
// decode failure -- a root-claim map/set/vec would never legitimately need it.
function readCompactU32(bytes, offset) {
  if (offset >= bytes.length) return null;
  const first = bytes[offset];
  const mode = first & 0b11;
  if (mode === 0b00) {
    return { value: first >>> 2, nextOffset: offset + 1 };
  }
  if (mode === 0b01) {
    if (offset + 2 > bytes.length) return null;
    const value = (first | (bytes[offset + 1] << 8)) >>> 2;
    return { value, nextOffset: offset + 2 };
  }
  if (mode === 0b10) {
    if (offset + 4 > bytes.length) return null;
    const value =
      ((bytes[offset] |
        (bytes[offset + 1] << 8) |
        (bytes[offset + 2] << 16) |
        (bytes[offset + 3] << 24)) >>>
        2) >>>
      0;
    return { value, nextOffset: offset + 4 };
  }
  return null; // mode 0b11: big-integer, unsupported here
}

const I96F32_FRAC_BITS = 32n;
const U128_MODULUS = 1n << 128n;
const I128_SIGN_BIT = 1n << 127n;

// I96F32 (substrate-fixed): 16 bytes two's-complement LE, 32 fractional bits.
// Split whole/remainder in BigInt space first to avoid float precision loss on
// the (up to 96-bit) integer part, mirroring subnet-lease.mjs's rawToDisplay.
function i96f32ToDisplay(bytes, offset) {
  const unsigned = readU128LEBigInt(bytes, offset);
  const signed = unsigned >= I128_SIGN_BIT ? unsigned - U128_MODULUS : unsigned;
  const scale = 1n << I96F32_FRAC_BITS;
  const negative = signed < 0n;
  const abs = negative ? -signed : signed;
  const value = Number(abs / scale) + Number(abs % scale) / Number(scale);
  return negative ? -value : value;
}

// Decode a RootClaimTypeEnum SCALE value: a 1-byte discriminant, plus (for
// KeepSubnets) a BTreeSet<NetUid> body. Returns null on any malformed input.
export function decodeRootClaimType(hex) {
  const bytes = hexToBytes(hex);
  if (!bytes || bytes.length === 0) return null;
  const tag = bytes[0];
  if (tag === 0) {
    return bytes.length === 1 ? { type: "swap", subnets: null } : null;
  }
  if (tag === 1) {
    return bytes.length === 1 ? { type: "keep", subnets: null } : null;
  }
  if (tag === 2) {
    const lenResult = readCompactU32(bytes, 1);
    if (!lenResult) return null;
    const { value: count, nextOffset } = lenResult;
    const subnets = [];
    let offset = nextOffset;
    for (let i = 0; i < count; i += 1) {
      if (offset + 2 > bytes.length) return null;
      subnets.push(readU16LE(bytes, offset));
      offset += 2;
    }
    if (offset !== bytes.length) return null; // trailing bytes -- malformed
    return { type: "keep_subnets", subnets };
  }
  return null; // unknown discriminant
}

// Decode a BTreeMap<NetUid, I96F32> SCALE value (RootClaimable's value type):
// a Compact<u32> count then count (u16 netuid, 16-byte I96F32) pairs. Returns
// null on malformed input; [] for a genuinely-empty map (the ValueQuery
// default when nothing is set).
export function decodeRootClaimable(hex) {
  const bytes = hexToBytes(hex);
  if (!bytes) return null;
  const lenResult = readCompactU32(bytes, 0);
  if (!lenResult) return null;
  const { value: count, nextOffset } = lenResult;
  const entries = [];
  let offset = nextOffset;
  for (let i = 0; i < count; i += 1) {
    if (offset + 2 + 16 > bytes.length) return null;
    const netuid = readU16LE(bytes, offset);
    offset += 2;
    const claimable = i96f32ToDisplay(bytes, offset);
    offset += 16;
    entries.push({ netuid, claimable });
  }
  if (offset !== bytes.length) return null; // trailing bytes -- malformed
  return entries;
}

// Decode a Vec<AccountId> SCALE value (OwnedHotkeys' value type): a
// Compact<u32> count then count 32-byte account ids, each re-encoded to an
// ss58 string. Returns null on malformed input; [] for a genuinely-empty vec.
export function decodeOwnedHotkeys(hex) {
  const bytes = hexToBytes(hex);
  if (!bytes) return null;
  const lenResult = readCompactU32(bytes, 0);
  if (!lenResult) return null;
  const { value: count, nextOffset } = lenResult;
  const hotkeys = [];
  let offset = nextOffset;
  for (let i = 0; i < count; i += 1) {
    if (offset + 32 > bytes.length) return null;
    hotkeys.push(encodeAccountId32(bytes.slice(offset, offset + 32)));
    offset += 32;
  }
  if (offset !== bytes.length) return null; // trailing bytes -- malformed
  return hotkeys;
}

// Decode a bare u128 SCALE value (RootClaimed's value type): exactly 16 bytes
// LE, returned as a BigInt. Returns null on any other length.
export function decodeU128(hex) {
  const bytes = hexToBytes(hex);
  if (!bytes || bytes.length !== 16) return null;
  return readU128LEBigInt(bytes, 0);
}

// Decode a bare I96F32 SCALE value (RootClaimableThreshold's value type):
// exactly 16 bytes, returned as a display number. Returns null otherwise.
export function decodeI96F32(hex) {
  const bytes = hexToBytes(hex);
  if (!bytes || bytes.length !== 16) return null;
  return i96f32ToDisplay(bytes, 0);
}

// Resolve every (hotkey, netuid) claimable entry for the coldkey across its
// owned hotkeys, enriching each with its cumulative RootClaimed and per-subnet
// RootClaimableThreshold. Returns null on any RPC/decode failure that leaves
// the set incomplete (schema-stable null propagates to the caller), or an
// object { entries, totalClaimable, totalClaimed } on success.
async function resolveClaimEntries(coldkeyId, hotkeys, timeoutMs) {
  const claimableResults = await Promise.all(
    hotkeys.map((hk) =>
      fetchStorageRaw(
        blake2ScopedKey("RootClaimable", accountIdFromSs58(hk)),
        timeoutMs,
      ),
    ),
  );

  const tuples = [];
  for (let i = 0; i < hotkeys.length; i += 1) {
    const result = claimableResults[i];
    if (!result.ok) return null;
    const list = result.raw === null ? [] : decodeRootClaimable(result.raw);
    if (list === null) return null;
    for (const entry of list) {
      tuples.push({
        hotkey: hotkeys[i],
        netuid: entry.netuid,
        claimable: entry.claimable,
      });
    }
  }

  const uniqueNetuids = [...new Set(tuples.map((t) => t.netuid))];
  const [thresholdResults, claimedResults] = await Promise.all([
    Promise.all(
      uniqueNetuids.map((netuid) =>
        fetchStorageRaw(
          blake2ScopedKey("RootClaimableThreshold", u16LeBytes(netuid)),
          timeoutMs,
        ),
      ),
    ),
    Promise.all(
      tuples.map((t) =>
        fetchStorageRaw(
          rootClaimedKey(t.netuid, accountIdFromSs58(t.hotkey), coldkeyId),
          timeoutMs,
        ),
      ),
    ),
  ]);

  const thresholdByNetuid = new Map();
  for (let i = 0; i < uniqueNetuids.length; i += 1) {
    const result = thresholdResults[i];
    if (!result.ok) return null;
    let threshold;
    if (result.raw === null) {
      threshold = DEFAULT_ROOT_CLAIM_THRESHOLD; // ValueQuery default
    } else {
      threshold = decodeI96F32(result.raw);
      if (threshold === null) return null;
    }
    thresholdByNetuid.set(uniqueNetuids[i], threshold);
  }

  const entries = [];
  let totalClaimable = 0;
  let totalClaimed = 0n;
  for (let i = 0; i < tuples.length; i += 1) {
    const result = claimedResults[i];
    if (!result.ok) return null;
    let claimed;
    if (result.raw === null) {
      claimed = 0n; // ValueQuery default
    } else {
      claimed = decodeU128(result.raw);
      if (claimed === null) return null;
    }
    const tuple = tuples[i];
    const threshold = thresholdByNetuid.get(tuple.netuid);
    entries.push({
      hotkey: tuple.hotkey,
      netuid: tuple.netuid,
      claimable: tuple.claimable,
      claimed: claimed.toString(),
      threshold,
      actionable: tuple.claimable >= threshold,
    });
    totalClaimable += tuple.claimable;
    totalClaimed += claimed;
  }

  // Stable ordering (by hotkey, then netuid) independent of RPC return order.
  entries.sort((a, b) =>
    a.hotkey < b.hotkey ? -1 : a.hotkey > b.hotkey ? 1 : a.netuid - b.netuid,
  );

  return { entries, totalClaimable, totalClaimed: totalClaimed.toString() };
}

// Query the live root-claim current-state for one coldkey: its claim-behavior
// setting (claim_type), the hotkeys it owns, and per (hotkey, netuid) the
// currently-claimable dividend, cumulative already-claimed, and dust-floor
// threshold, plus coldkey-level aggregates. claim_type/hotkeys/entries are each
// independently null on their own RPC/decode failure (schema-stable, never
// throws on a live-RPC failure) -- distinct from a confirmed-empty [] (the
// common case: a coldkey with no owned hotkeys, or none with pending claims).
export async function loadRootClaim(env, ss58) {
  if (!isFinneySs58Address(ss58)) {
    throw new RangeError("ss58 must be a valid finney SS58 account address");
  }
  const coldkeyId = accountIdFromSs58(ss58);

  const cacheKey = `root-claim:${ss58}`;
  const kv = env?.METAGRAPH_CONTROL;
  if (kv?.get) {
    try {
      const cached = await kv.get(cacheKey, { type: "json" });
      if (cached) return cached;
    } catch {
      // KV read failure is non-fatal — fall through to the live RPC.
    }
  }

  const queriedAt = new Date().toISOString();
  const timeout = ROOT_CLAIM_RPC_TIMEOUT_MS;

  const [typeResult, hotkeysResult] = await Promise.all([
    fetchStorageRaw(blake2ScopedKey("RootClaimType", coldkeyId), timeout),
    fetchStorageRaw(blake2ScopedKey("OwnedHotkeys", coldkeyId), timeout),
  ]);

  let claimType = null;
  if (typeResult.ok) {
    claimType =
      typeResult.raw === null
        ? { type: "swap", subnets: null } // ValueQuery default RootClaimTypeEnum::Swap
        : decodeRootClaimType(typeResult.raw);
  }

  let hotkeys = null;
  if (hotkeysResult.ok) {
    hotkeys =
      hotkeysResult.raw === null ? [] : decodeOwnedHotkeys(hotkeysResult.raw);
  }

  let hotkeysTruncated = false;
  let processed = hotkeys;
  if (Array.isArray(hotkeys) && hotkeys.length > MAX_HOTKEYS) {
    processed = hotkeys.slice(0, MAX_HOTKEYS);
    hotkeysTruncated = true;
  }

  let entries = null;
  let totalClaimable = null;
  let totalClaimed = null;
  if (Array.isArray(processed)) {
    const resolved = await resolveClaimEntries(coldkeyId, processed, timeout);
    if (resolved) {
      entries = resolved.entries;
      totalClaimable = resolved.totalClaimable;
      totalClaimed = resolved.totalClaimed;
    }
  }

  const payload = {
    schema_version: 1,
    account: ss58,
    claim_type: claimType,
    hotkeys,
    hotkeys_truncated: hotkeysTruncated,
    entries,
    total_claimable: totalClaimable,
    total_claimed: totalClaimed,
    queried_at: queriedAt,
  };

  // Positive-cache only a fully-resolved read (claim_type decoded and the full
  // entry set built); any partial failure gets the short negative TTL so a
  // transient miss isn't held for the full window (mirrors network-
  // parameters.mjs's per-field caching posture).
  const fullyResolved = claimType !== null && entries !== null;
  if (kv?.put) {
    try {
      await kv.put(cacheKey, JSON.stringify(payload), {
        expirationTtl: fullyResolved
          ? ROOT_CLAIM_KV_TTL
          : ROOT_CLAIM_NEGATIVE_KV_TTL,
      });
    } catch {
      // KV write failure is non-fatal.
    }
  }

  return payload;
}
