// Live subnet-lease state (#6719, part of the subnet-leasing/crowdloan-
// tracking epic #6717): whether a subnet is currently under a lease (via
// #6718's register_leased_network extrinsic + a crowdloan) and, if so, the
// lease's terms and accumulated-but-undistributed alpha dividends.
// Live-RPC + KV-cache route, same shape as subnet-burn.ts/network-
// parameters.mjs -- current chain state, not a historical event stream (see
// subnet-lease-history.mjs for that).
//
// Storage items (pallets/subtensor/src/subnets/leasing.rs, fetched from
// opentensor/subtensor's own GitHub source 2026-07-18 to get the
// authoritative struct layout + hasher/key-width rather than guess it --
// LeaseId is a u32, NOT u64, which is easy to get wrong by analogy with the
// u64 rao/alpha VALUE types this codebase decodes everywhere else):
//   SubnetUidToLeaseId: StorageMap<_, Twox64Concat, NetUid(u16), LeaseId(u32), OptionQuery>
//   SubnetLeases: StorageMap<_, Twox64Concat, LeaseId(u32), SubnetLease<AccountId,u32,TaoBalance(u64)>, OptionQuery>
//   AccumulatedLeaseDividends: StorageMap<_, Twox64Concat, LeaseId(u32), AlphaBalance(u64), ValueQuery>
//
// SubnetLease's #[derive(Encode, Decode)] field order IS its SCALE encoding
// order (no explicit discriminants on a plain struct):
//   beneficiary: AccountId (32 bytes), coldkey: AccountId (32 bytes),
//   hotkey: AccountId (32 bytes), emissions_share: Percent (1 byte raw u8 --
//   Percent's ACCURACY==100 so from_percent(x) == from_parts(x), the raw
//   byte already IS the percent 0..=100, no further scaling), end_block:
//   Option<u32> (1-byte tag + 4 bytes LE if Some), netuid: NetUid (2 bytes
//   LE u16), cost: TaoBalance (8 bytes LE u64, rao).
//
// SubnetLeaseShares (per-contributor share breakdown) is a Twox64Concat +
// Identity StorageDoubleMap requiring paginated key enumeration rather than
// a single get -- deliberately NOT included here; a future extension, not
// part of #6719's scope.
//
// twox64ConcatU16StorageKey/twox64ConcatU32StorageKey (src/twox-storage-
// key.mjs) compute the per-request map-key suffix; unlike subnet-burn.ts's
// single hardcoded prefix, this file needs three different item prefixes so
// they're computed via that shared module rather than each hardcoded here.

import { encodeAccountId32 } from "./ss58.ts";
import { isU16Netuid } from "./subnet-recycled.mjs";
import {
  twox64ConcatU16StorageKey,
  twox64ConcatU32StorageKey,
} from "./twox-storage-key.ts";

export const SUBNET_LEASE_KV_TTL = 120; // seconds -- same freshness profile as subnet-burn.ts
export const SUBNET_LEASE_NEGATIVE_KV_TTL = 10; // seconds
export const SUBNET_LEASE_RPC_TIMEOUT_MS = 5000;
const FINNEY_RPC_URL = "https://entrypoint-finney.opentensor.ai:443";

// One raw state_getStorage read. `ok` is false only on a genuine RPC
// failure (non-2xx / timeout / network error); `raw` is the JSON-RPC
// result on success, which is itself `null` for a genuinely-absent key.
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

function readU32LE(bytes, offset) {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

function readU64LEBigInt(bytes, offset) {
  let value = 0n;
  for (let i = 7; i >= 0; i -= 1) {
    value = (value << 8n) | BigInt(bytes[offset + i]);
  }
  return value;
}

// BigInt rao/alpha (both u64 @ 1e9 precision) -> Number display units, split
// in BigInt space first to avoid float precision loss (mirrors subnet-
// burn.mjs's / network-parameters.ts's identical conversion).
function rawToDisplay(raw) {
  return Number(raw / 1_000_000_000n) + Number(raw % 1_000_000_000n) / 1e9;
}

const SUBNET_LEASE_BYTES_NO_END_BLOCK = 32 + 32 + 32 + 1 + 1 + 2 + 8;
const SUBNET_LEASE_BYTES_WITH_END_BLOCK = SUBNET_LEASE_BYTES_NO_END_BLOCK + 4;

// Decode one SubnetLease<AccountId, u32, TaoBalance> SCALE-encoded value
// (see this module's header for the field-order source). Returns null on
// any malformed/wrong-length input rather than throwing -- a live-RPC route
// must stay schema-stable even against an unexpected chain-side shape.
export function decodeSubnetLease(hex) {
  const bytes = hexToBytes(hex);
  if (
    !bytes ||
    (bytes.length !== SUBNET_LEASE_BYTES_NO_END_BLOCK &&
      bytes.length !== SUBNET_LEASE_BYTES_WITH_END_BLOCK)
  ) {
    return null;
  }

  let offset = 0;
  const beneficiary = encodeAccountId32(bytes.slice(offset, offset + 32));
  offset += 32;
  const coldkey = encodeAccountId32(bytes.slice(offset, offset + 32));
  offset += 32;
  const hotkey = encodeAccountId32(bytes.slice(offset, offset + 32));
  offset += 32;

  const emissionsSharePercent = bytes[offset];
  offset += 1;

  const endBlockTag = bytes[offset];
  offset += 1;
  let endBlock = null;
  if (endBlockTag === 1) {
    if (bytes.length !== SUBNET_LEASE_BYTES_WITH_END_BLOCK) return null;
    endBlock = readU32LE(bytes, offset);
    offset += 4;
  } else if (endBlockTag === 0) {
    if (bytes.length !== SUBNET_LEASE_BYTES_NO_END_BLOCK) return null;
  } else {
    return null; // malformed Option<u32> tag
  }

  const netuid = readU16LE(bytes, offset);
  offset += 2;
  const costRao = readU64LEBigInt(bytes, offset);

  return {
    beneficiary,
    coldkey,
    hotkey,
    emissions_share_percent: emissionsSharePercent,
    end_block: endBlock,
    netuid,
    cost_tao: rawToDisplay(costRao),
  };
}

// Query the live lease state for one subnet: whether it's currently under a
// lease and, if so, the lease's terms + accumulated-but-undistributed alpha
// dividends. `leased: null` (not false) on RPC failure -- distinct from a
// confirmed "no lease" (`leased: false`), matching the schema-stable-null
// convention every sibling live-RPC route in this codebase uses (subnet-
// burn.mjs's burn_tao: null, etc). `lease: null` while `leased: true` means
// the lease was confirmed to exist but its details couldn't be fetched/
// decoded this request (transient RPC failure, or a race between the two
// sequential reads if the lease was terminated in between) -- callers
// should treat that as "retry", not "no lease".
export async function loadSubnetLease(env, netuid) {
  if (!isU16Netuid(netuid)) {
    throw new RangeError("netuid must be an integer in the u16 range 0..65535");
  }

  const cacheKey = `lease:${netuid}`;
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
  const timeout = SUBNET_LEASE_RPC_TIMEOUT_MS;

  let leased = null;
  let lease = null;
  let rpcOk = false;

  const leaseIdKey = twox64ConcatU16StorageKey(
    "SubtensorModule",
    "SubnetUidToLeaseId",
    netuid,
  );
  const leaseIdResult = await fetchStorageRaw(leaseIdKey, timeout);

  let leaseId = null;
  if (leaseIdResult.ok) {
    if (leaseIdResult.raw === null) {
      leased = false;
      rpcOk = true;
    } else {
      const leaseIdBytes = hexToBytes(leaseIdResult.raw);
      if (leaseIdBytes && leaseIdBytes.length === 4) {
        leaseId = readU32LE(leaseIdBytes, 0);
        leased = true;
      }
    }
  }

  if (leased === true && leaseId != null) {
    const leaseKey = twox64ConcatU32StorageKey(
      "SubtensorModule",
      "SubnetLeases",
      leaseId,
    );
    const dividendsKey = twox64ConcatU32StorageKey(
      "SubtensorModule",
      "AccumulatedLeaseDividends",
      leaseId,
    );
    const [leaseResult, dividendsResult] = await Promise.all([
      fetchStorageRaw(leaseKey, timeout),
      fetchStorageRaw(dividendsKey, timeout),
    ]);

    const decoded =
      leaseResult.ok && typeof leaseResult.raw === "string"
        ? decodeSubnetLease(leaseResult.raw)
        : null;

    if (decoded) {
      let accumulatedDividendsAlpha = null;
      let dividendsOk = false;
      if (dividendsResult.ok) {
        if (dividendsResult.raw === null) {
          accumulatedDividendsAlpha = 0; // ValueQuery default
          dividendsOk = true;
        } else if (/^0x[0-9a-fA-F]{16}$/.test(dividendsResult.raw)) {
          accumulatedDividendsAlpha = rawToDisplay(
            readU64LEBigInt(hexToBytes(dividendsResult.raw), 0),
          );
          dividendsOk = true;
        }
      }
      // Positive-cache only when both sub-reads succeed (mirrors network-
      // parameters.mjs: a partial failure shouldn't cache a stale-looking
      // result for the full TTL).
      lease = {
        lease_id: leaseId,
        ...decoded,
        accumulated_dividends_alpha: accumulatedDividendsAlpha,
      };
      rpcOk = dividendsOk;
    }
  }

  const payload = {
    schema_version: 1,
    netuid,
    leased,
    lease,
    queried_at: queriedAt,
  };

  if (kv?.put) {
    try {
      await kv.put(cacheKey, JSON.stringify(payload), {
        expirationTtl: rpcOk
          ? SUBNET_LEASE_KV_TTL
          : SUBNET_LEASE_NEGATIVE_KV_TTL,
      });
    } catch {
      // KV write failure is non-fatal.
    }
  }

  return payload;
}
