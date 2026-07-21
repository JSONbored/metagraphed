// Live child-hotkey delegation graph (#6723, part of epic #6721): who a
// hotkey has delegated stake-weight to (as children) and who has delegated
// to it (as parents), per subnet, with the take rate charged. We already
// serve the BOUNDS (take-ratio limits, cooldown periods as hyperparameters)
// but not this live graph itself. Directly analogous to
// src/validator-nominators.mjs's already-shipped shape, just reading a
// different pair of storage maps.
//
// Storage (pallets/subtensor/src/lib.rs, fetched from opentensor/subtensor's
// own GitHub source 2026-07-18 for the authoritative hasher/type layout):
//   ChildKeys:  StorageDoubleMap<_, Blake2_128Concat, AccountId (parent),
//               Identity, NetUid, Vec<(u64 proportion, AccountId child)>, ValueQuery>
//   ParentKeys: StorageDoubleMap<_, Blake2_128Concat, AccountId (child),
//               Identity, NetUid, Vec<(u64 proportion, AccountId parent)>, ValueQuery>
//   ChildkeyTake: StorageDoubleMap<_, Blake2_128Concat, AccountId (hotkey),
//               Identity, NetUid, PerU16, ValueQuery>
//
// Both ChildKeys and ParentKeys are keyed by (account, netuid) but this
// route is account-scoped only (not also netuid-scoped) -- callers want
// "everywhere this hotkey has children/parents", not one subnet at a time.
// That means enumerating every netuid under the account's Blake2_128Concat-
// hashed first-key prefix via state_getKeysPaged (the RPC proxy's own
// SAFE_RPC_STATE_QUERY_METHODS allowlist already documents this as the
// bounded way to enumerate a prefix -- state_getPairs is deliberately
// excluded there for having no caller-side pagination at all), then reading
// each matching key's value. In practice this returns a handful of rows
// (a hotkey rarely has children/parents on more than a few subnets), so a
// single state_getKeysPaged page (well above any realistic count) plus one
// state_getStorage per returned key (in parallel) is simpler and safer than
// introducing a batched state_queryStorageAt shape this codebase has never
// used before.
//
// blake2_128Concat(x) = blake2b-128(x) ++ x, reusing src/account-balance.mjs's
// own already-live-verified pattern (System::Account's storage key) rather
// than a new primitive -- @noble/hashes' blake2b already covers this, unlike
// twox64/twox128 (src/twox-storage-key.mjs), which needed a hand-rolled
// implementation because no XXHash64 dependency exists in this repo.

import { blake2b } from "@noble/hashes/blake2.js";
import { encodeAccountId32 } from "./ss58.ts";
import { isFinneySs58Address } from "./account-balance.ts";
import { storageMapPrefix, bytesToHex } from "./twox-storage-key.ts";

export const CHILD_HOTKEY_KV_TTL = 120; // seconds -- live chain state, same profile as subnet-lease.mjs
export const CHILD_HOTKEY_NEGATIVE_KV_TTL = 10; // seconds
export const CHILD_HOTKEY_RPC_TIMEOUT_MS = 5000;
const FINNEY_RPC_URL = "https://entrypoint-finney.opentensor.ai:443";
// A hotkey having children/parents on more than a handful of subnets would
// be extraordinary; this stays a single state_getKeysPaged page in every
// realistic case while still bounding a pathological account.
const MAX_NETUID_KEYS = 250;

// Only ever called after isFinneySs58Address(ss58) has already proved `ss58`
// is a valid base58 string decoding to exactly 35 bytes (prefix + AccountId32
// + checksum) with the finney prefix and a matching checksum -- so every
// character is known-valid, decoded.length is always 35 (no truncated/
// malformed input reaches here), and byte[0] (the prefix, 42) is never zero,
// meaning there's no leading-zero-byte case to reconstruct via a leading '1'
// character either. No defensive re-checks here: trusting a precondition
// the caller already verified, matching this codebase's "don't validate
// twice" convention. Duplicates account-balance.mjs's base58 decode rather
// than importing it (self-contained-module convention already established
// by subnet-burn.mjs/sudo-key.mjs for small codec helpers).
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

// The fixed prefix ++ Blake2_128Concat(accountId) -- everything up to (but
// not including) the trailing Identity-hashed netuid suffix, which varies
// per returned key and is read back from state_getKeysPaged's own results.
function accountScopedStoragePrefix(itemName, accountId) {
  const prefix = storageMapPrefix("SubtensorModule", itemName);
  const hashed = blake2_128Concat(accountId);
  const out = new Uint8Array(prefix.length + hashed.length);
  out.set(prefix, 0);
  out.set(hashed, prefix.length);
  return bytesToHex(out);
}

async function rpcCall(method, params, timeoutMs) {
  try {
    const resp = await fetch(FINNEY_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!resp.ok) return { ok: false, result: undefined };
    const body = await resp.json();
    return { ok: true, result: body?.result };
  } catch {
    return { ok: false, result: undefined };
  }
}

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

function readU64LEBigInt(bytes, offset) {
  let value = 0n;
  for (let i = 7; i >= 0; i -= 1) {
    value = (value << 8n) | BigInt(bytes[offset + i]);
  }
  return value;
}

// SCALE Compact<u32> at `offset`. Returns { value, nextOffset } or null on a
// malformed/unsupported encoding. Modes 0/1/2 (single-byte/two-byte/four-byte)
// cover every realistic Vec length here (the pallet caps children at 5 per
// hotkey); mode 3 (big-integer) is intentionally NOT decoded -- a delegation
// list would never legitimately need it, so treating it as a decode failure
// is safer than guessing at an unbounded byte-length prefix.
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

// u64 proportion (0..u64::MAX represents 0..100% of stake-weight, per the
// pallet's own "Ensures sum(proportions) <= u64::MAX" invariant) -> a plain
// 0..1 float. Split whole/remainder in BigInt space first for the same
// precision reason src/network-parameters.mjs's u64f64ToFloat does.
const U64_SCALE = 2n ** 64n;
function proportionToFraction(raw) {
  const whole = raw / U64_SCALE;
  const remainder = raw % U64_SCALE;
  return Number(whole) + Number(remainder) / Number(U64_SCALE);
}

// Decode a Vec<(u64, AccountId)> SCALE value (ChildKeys/ParentKeys' value
// type). Returns null on malformed input; [] for a genuinely empty list
// (the ValueQuery default when nothing is set). counterpartKey names the
// decoded account field ("child" or "parent").
export function decodeProportionAccountList(hex, counterpartKey) {
  const bytes = hexToBytes(hex);
  if (!bytes) return null;
  const lenResult = readCompactU32(bytes, 0);
  if (!lenResult) return null;
  const { value: count, nextOffset } = lenResult;
  const entries = [];
  let offset = nextOffset;
  for (let i = 0; i < count; i += 1) {
    if (offset + 8 + 32 > bytes.length) return null;
    const proportionRaw = readU64LEBigInt(bytes, offset);
    offset += 8;
    const account = encodeAccountId32(bytes.slice(offset, offset + 32));
    offset += 32;
    entries.push({
      [counterpartKey]: account,
      proportion: proportionRaw.toString(),
      proportion_fraction: proportionToFraction(proportionRaw),
    });
  }
  if (offset !== bytes.length) return null; // trailing bytes -- malformed
  return entries;
}

// Enumerate every (netuid, Vec<(proportion, counterpart)>) entry for one
// hotkey under `itemName` ("ChildKeys" or "ParentKeys"). Returns null on RPC
// failure (schema-stable null propagates to the caller); [] when the hotkey
// genuinely has none (the common case).
async function loadDelegationEntries(
  accountId,
  itemName,
  counterpartKey,
  timeoutMs,
) {
  const prefix = accountScopedStoragePrefix(itemName, accountId);
  const keysResult = await rpcCall(
    "state_getKeysPaged",
    [prefix, MAX_NETUID_KEYS, prefix],
    timeoutMs,
  );
  if (!keysResult.ok) return null;
  const keys = Array.isArray(keysResult.result) ? keysResult.result : [];
  if (keys.length === 0) return [];

  const valueResults = await Promise.all(
    keys.map((key) => rpcCall("state_getStorage", [key], timeoutMs)),
  );

  const rows = [];
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    const keyBytes = hexToBytes(key);
    if (!keyBytes || keyBytes.length < 2) return null;
    const netuid = readU16LE(keyBytes, keyBytes.length - 2);

    const valueResult = valueResults[i];
    if (!valueResult.ok) return null;
    // A genuinely-unset entry reads back the ValueQuery default (empty
    // list), not a failure -- state_getKeysPaged only returned this key
    // because SOME value exists there, but decode defensively anyway.
    if (valueResult.result === null) {
      rows.push({ netuid, entries: [] });
      continue;
    }
    const entries = decodeProportionAccountList(
      valueResult.result,
      counterpartKey,
    );
    if (entries === null) return null;
    rows.push({ netuid, entries });
  }
  return rows;
}

async function loadChildHotkeyGraph(
  env,
  ss58,
  itemName,
  counterpartKey,
  cacheKeyPrefix,
) {
  if (!isFinneySs58Address(ss58)) {
    throw new RangeError("ss58 must be a valid finney SS58 account address");
  }
  const accountId = accountIdFromSs58(ss58);

  const cacheKey = `${cacheKeyPrefix}:${ss58}`;
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
  const rows = await loadDelegationEntries(
    accountId,
    itemName,
    counterpartKey,
    CHILD_HOTKEY_RPC_TIMEOUT_MS,
  );
  const ok = rows !== null;

  const payload = {
    schema_version: 1,
    account: ss58,
    subnets: ok
      ? rows
          .filter((row) => row.entries.length > 0)
          .sort((a, b) => a.netuid - b.netuid)
      : null,
    queried_at: queriedAt,
  };

  if (kv?.put) {
    try {
      await kv.put(cacheKey, JSON.stringify(payload), {
        expirationTtl: ok ? CHILD_HOTKEY_KV_TTL : CHILD_HOTKEY_NEGATIVE_KV_TTL,
      });
    } catch {
      // KV write failure is non-fatal.
    }
  }

  return payload;
}

// Query every child hotkey (and its per-subnet proportion/take context) this
// hotkey currently delegates stake-weight to. `subnets: null` on RPC
// failure; `subnets: []` when the hotkey genuinely has no children anywhere
// (the common case) -- schema-stable, never throws on a live-RPC failure.
export async function loadAccountChildren(env, ss58) {
  return loadChildHotkeyGraph(env, ss58, "ChildKeys", "child", "children");
}

// Query every parent hotkey currently delegating stake-weight to this
// hotkey. Same shape as loadAccountChildren, reading ParentKeys instead.
export async function loadAccountParents(env, ss58) {
  return loadChildHotkeyGraph(env, ss58, "ParentKeys", "parent", "parents");
}
