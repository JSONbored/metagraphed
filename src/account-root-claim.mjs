// Live root-claim current-state read (#7229): claimable rates, claim type,
// and cumulative claimed totals for a Finney ss58 account. Read-only — never
// submits claim_root or any other extrinsic (same posture as account-balance /
// subnet-lease).
//
// Storage (opentensor/subtensor pallets/subtensor/src/lib.rs, verified 2026-07-20):
//   RootClaimable(hotkey) -> BTreeMap<NetUid, I96F32>     Blake2_128Concat
//   RootClaimType(account) -> RootClaimTypeEnum           Blake2_128Concat
//   RootClaimed(netuid, hotkey, account) -> u128          NMap Identity+Blake2×2
//   RootClaimableThreshold(netuid) -> I96F32              Blake2_128Concat
//   StakingHotkeys(account) -> Vec<AccountId>             Blake2_128Concat
//     (do_root_claim enumerates these; OwnedHotkeys is the fallback when empty)
//   OwnedHotkeys(account) -> Vec<AccountId>               Blake2_128Concat
//
// RootClaimable stores a *rate*; absolute owed alpha is rate × root stake
// minus RootClaimed (see claim_root.rs). v1 surfaces the on-chain storage
// items directly — computing stake-weighted owed is a natural follow-up.
//
// Blake2_128Concat + storageMapPrefix reuse the child-hotkey-delegation
// pattern; I96F32 decode mirrors network-parameters' fixed-point split.

import { blake2b } from "@noble/hashes/blake2.js";
import { encodeAccountId32 } from "./ss58.ts";
import { isFinneySs58Address } from "./account-balance.mjs";
import { storageMapPrefix, bytesToHex } from "./twox-storage-key.ts";

export const ROOT_CLAIM_KV_TTL = 120; // seconds
export const ROOT_CLAIM_NEGATIVE_KV_TTL = 10; // seconds
export const ROOT_CLAIM_RPC_TIMEOUT_MS = 5000;
const FINNEY_RPC_URL = "https://entrypoint-finney.opentensor.ai:443";
const I96F32_SCALE = 2n ** 32n;
const I96F32_BYTES = 16;
const ACCOUNT_ID_BYTES = 32;
const MAX_HOTKEYS = 64;

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

function u16LeBytes(netuid) {
  return Uint8Array.of(netuid & 0xff, (netuid >>> 8) & 0xff);
}

function accountScopedKey(itemName, accountId) {
  const prefix = storageMapPrefix("SubtensorModule", itemName);
  const hashed = blake2_128Concat(accountId);
  const out = new Uint8Array(prefix.length + hashed.length);
  out.set(prefix, 0);
  out.set(hashed, prefix.length);
  return bytesToHex(out);
}

function thresholdKey(netuid) {
  const prefix = storageMapPrefix("SubtensorModule", "RootClaimableThreshold");
  const hashed = blake2_128Concat(u16LeBytes(netuid));
  const out = new Uint8Array(prefix.length + hashed.length);
  out.set(prefix, 0);
  out.set(hashed, prefix.length);
  return bytesToHex(out);
}

function claimedKey(netuid, hotAccountId, coldAccountId) {
  const prefix = storageMapPrefix("SubtensorModule", "RootClaimed");
  const net = u16LeBytes(netuid);
  const hot = blake2_128Concat(hotAccountId);
  const cold = blake2_128Concat(coldAccountId);
  const out = new Uint8Array(
    prefix.length + net.length + hot.length + cold.length,
  );
  let offset = 0;
  out.set(prefix, offset);
  offset += prefix.length;
  out.set(net, offset);
  offset += net.length;
  out.set(hot, offset);
  offset += hot.length;
  out.set(cold, offset);
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
    if (body?.error) return { ok: false, result: undefined };
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

function readI128Le(bytes, offset) {
  let value = 0n;
  for (let i = I96F32_BYTES - 1; i >= 0; i -= 1) {
    value = (value << 8n) | BigInt(bytes[offset + i]);
  }
  // Sign-extend: if high bit of byte 15 is set, treat as negative i128.
  if (bytes[offset + I96F32_BYTES - 1] & 0x80) {
    value -= 1n << 128n;
  }
  return value;
}

function readU128Le(bytes, offset) {
  let value = 0n;
  for (let i = I96F32_BYTES - 1; i >= 0; i -= 1) {
    value = (value << 8n) | BigInt(bytes[offset + i]);
  }
  return value;
}

/** I96F32 bits → float (value / 2^32). */
export function i96f32ToFloat(bits) {
  const whole = bits / I96F32_SCALE;
  const remainder = bits % I96F32_SCALE;
  // Remainder is negative when bits is negative — Number(remainder)/scale preserves sign.
  return Number(whole) + Number(remainder) / Number(I96F32_SCALE);
}

function readCompactU32(bytes, offset) {
  if (offset >= bytes.length) return null;
  const first = bytes[offset];
  const mode = first & 0b11;
  if (mode === 0b00) {
    return { value: first >>> 2, nextOffset: offset + 1 };
  }
  if (mode === 0b01) {
    if (offset + 2 > bytes.length) return null;
    return {
      value: (first | (bytes[offset + 1] << 8)) >>> 2,
      nextOffset: offset + 2,
    };
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
  return null;
}

/** Decode RootClaimTypeEnum SCALE. null on malformed. */
export function decodeRootClaimType(hex) {
  // ValueQuery default Swap when storage is unset.
  if (hex == null) return { kind: "Swap" };
  const bytes = hexToBytes(hex);
  if (!bytes || bytes.length === 0) return null;
  const tag = bytes[0];
  if (tag === 0) {
    if (bytes.length !== 1) return null;
    return { kind: "Swap" };
  }
  if (tag === 1) {
    if (bytes.length !== 1) return null;
    return { kind: "Keep" };
  }
  if (tag === 2) {
    const lenResult = readCompactU32(bytes, 1);
    if (!lenResult) return null;
    const { value: count, nextOffset } = lenResult;
    const subnets = [];
    let offset = nextOffset;
    for (let i = 0; i < count; i += 1) {
      if (offset + 2 > bytes.length) return null;
      subnets.push(bytes[offset] | (bytes[offset + 1] << 8));
      offset += 2;
    }
    if (offset !== bytes.length) return null;
    return { kind: "KeepSubnets", subnets };
  }
  return null;
}

/** Decode BTreeMap<NetUid, I96F32>. null on malformed; [] when empty/unset. */
export function decodeClaimableMap(hex) {
  if (hex == null) return [];
  const bytes = hexToBytes(hex);
  if (!bytes) return null;
  if (bytes.length === 0) return [];
  const lenResult = readCompactU32(bytes, 0);
  if (!lenResult) return null;
  const { value: count, nextOffset } = lenResult;
  const entries = [];
  let offset = nextOffset;
  for (let i = 0; i < count; i += 1) {
    if (offset + 2 + I96F32_BYTES > bytes.length) return null;
    const netuid = bytes[offset] | (bytes[offset + 1] << 8);
    offset += 2;
    const rateBits = readI128Le(bytes, offset);
    offset += I96F32_BYTES;
    entries.push({
      netuid,
      claimable_rate: i96f32ToFloat(rateBits),
    });
  }
  if (offset !== bytes.length) return null;
  return entries;
}

/** Decode Vec<AccountId> (StakingHotkeys / OwnedHotkeys). */
export function decodeAccountIdVec(hex) {
  if (hex == null) return [];
  const bytes = hexToBytes(hex);
  if (!bytes) return null;
  if (bytes.length === 0) return [];
  const lenResult = readCompactU32(bytes, 0);
  if (!lenResult) return null;
  const { value: count, nextOffset } = lenResult;
  const accounts = [];
  let offset = nextOffset;
  for (let i = 0; i < count; i += 1) {
    if (offset + ACCOUNT_ID_BYTES > bytes.length) return null;
    accounts.push(
      encodeAccountId32(bytes.slice(offset, offset + ACCOUNT_ID_BYTES)),
    );
    offset += ACCOUNT_ID_BYTES;
  }
  if (offset !== bytes.length) return null;
  return accounts;
}

/** Decode I96F32 ValueQuery (threshold). null unset→default handled by caller. */
export function decodeI96F32(hex) {
  if (hex == null) return 0;
  const bytes = hexToBytes(hex);
  if (!bytes || bytes.length !== I96F32_BYTES) return null;
  return i96f32ToFloat(readI128Le(bytes, 0));
}

/** Decode u128 ValueQuery (RootClaimed). */
export function decodeU128(hex) {
  if (hex == null) return "0";
  const bytes = hexToBytes(hex);
  if (!bytes || bytes.length !== I96F32_BYTES) return null;
  return readU128Le(bytes, 0).toString();
}

async function fetchStorage(key, timeoutMs) {
  const result = await rpcCall("state_getStorage", [key], timeoutMs);
  if (!result.ok) return { ok: false, hex: undefined };
  return { ok: true, hex: result.result ?? null };
}

/**
 * Live root-claim state for one Finney ss58 account. Uses METAGRAPH_CONTROL KV
 * (120s / 10s negative). On RPC failure: claim_type/hotkeys are null
 * (schema-stable), never throws.
 */
export async function loadAccountRootClaim(env, ss58) {
  if (!isFinneySs58Address(ss58)) {
    throw new RangeError("ss58 must be a valid finney SS58 account address");
  }

  const cacheKey = `root-claim:${ss58}`;
  const kv = env?.METAGRAPH_CONTROL;
  if (kv?.get) {
    try {
      const cached = await kv.get(cacheKey, { type: "json" });
      if (cached) return cached;
    } catch {
      // non-fatal
    }
  }

  const queriedAt = new Date().toISOString();
  const coldAccountId = accountIdFromSs58(ss58);
  const timeoutMs = ROOT_CLAIM_RPC_TIMEOUT_MS;

  const [claimTypeRaw, stakingHotkeysRaw, ownedHotkeysRaw] = await Promise.all([
    fetchStorage(accountScopedKey("RootClaimType", coldAccountId), timeoutMs),
    fetchStorage(accountScopedKey("StakingHotkeys", coldAccountId), timeoutMs),
    fetchStorage(accountScopedKey("OwnedHotkeys", coldAccountId), timeoutMs),
  ]);

  if (!claimTypeRaw.ok || !stakingHotkeysRaw.ok || !ownedHotkeysRaw.ok) {
    const payload = {
      schema_version: 1,
      ss58,
      claim_type: null,
      hotkeys: null,
      queried_at: queriedAt,
    };
    if (kv?.put) {
      try {
        await kv.put(cacheKey, JSON.stringify(payload), {
          expirationTtl: ROOT_CLAIM_NEGATIVE_KV_TTL,
        });
      } catch {
        // non-fatal
      }
    }
    return payload;
  }

  const claimType = decodeRootClaimType(claimTypeRaw.hex);
  const stakingHotkeys = decodeAccountIdVec(stakingHotkeysRaw.hex);
  const ownedHotkeys = decodeAccountIdVec(ownedHotkeysRaw.hex);

  if (claimType == null || stakingHotkeys == null || ownedHotkeys == null) {
    const payload = {
      schema_version: 1,
      ss58,
      claim_type: null,
      hotkeys: null,
      queried_at: queriedAt,
    };
    if (kv?.put) {
      try {
        await kv.put(cacheKey, JSON.stringify(payload), {
          expirationTtl: ROOT_CLAIM_NEGATIVE_KV_TTL,
        });
      } catch {
        // non-fatal
      }
    }
    return payload;
  }

  // Prefer StakingHotkeys (matches do_root_claim); fall back to OwnedHotkeys.
  const hotkeyList = (
    stakingHotkeys.length > 0 ? stakingHotkeys : ownedHotkeys
  ).slice(0, MAX_HOTKEYS);

  const hotkeyRows = await Promise.all(
    hotkeyList.map(async (hotkey) => {
      const hotAccountId = accountIdFromSs58(hotkey);
      const claimableRaw = await fetchStorage(
        accountScopedKey("RootClaimable", hotAccountId),
        timeoutMs,
      );
      if (!claimableRaw.ok) return null;
      const rates = decodeClaimableMap(claimableRaw.hex);
      if (rates == null) return null;

      const entries = await Promise.all(
        rates.map(async (row) => {
          const [claimedRaw, thresholdRaw] = await Promise.all([
            fetchStorage(
              claimedKey(row.netuid, hotAccountId, coldAccountId),
              timeoutMs,
            ),
            fetchStorage(thresholdKey(row.netuid), timeoutMs),
          ]);
          if (!claimedRaw.ok || !thresholdRaw.ok) return null;
          const claimed = decodeU128(claimedRaw.hex);
          const threshold = decodeI96F32(thresholdRaw.hex);
          if (claimed == null || threshold == null) return null;
          return {
            netuid: row.netuid,
            claimable_rate: row.claimable_rate,
            claimed,
            threshold,
          };
        }),
      );
      if (entries.some((e) => e == null)) return null;
      return { hotkey, entries };
    }),
  );

  if (hotkeyRows.some((row) => row == null)) {
    const payload = {
      schema_version: 1,
      ss58,
      claim_type: null,
      hotkeys: null,
      queried_at: queriedAt,
    };
    if (kv?.put) {
      try {
        await kv.put(cacheKey, JSON.stringify(payload), {
          expirationTtl: ROOT_CLAIM_NEGATIVE_KV_TTL,
        });
      } catch {
        // non-fatal
      }
    }
    return payload;
  }

  const payload = {
    schema_version: 1,
    ss58,
    claim_type: claimType,
    hotkeys: hotkeyRows,
    queried_at: queriedAt,
  };

  if (kv?.put) {
    try {
      await kv.put(cacheKey, JSON.stringify(payload), {
        expirationTtl: ROOT_CLAIM_KV_TTL,
      });
    } catch {
      // non-fatal
    }
  }

  return payload;
}
