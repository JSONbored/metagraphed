// Live root-claim current-state read (#7229): claimable rates, claim type,
// and cumulative claimed totals for a Finney ss58 account. Read-only — never
// submits claim_root or any other extrinsic (same posture as account-balance /
// subnet-lease).
//
// Legacy storage adapter: node-subtensor v440 only. Root Reborn (v441)
// removed RootClaimType and retained claimable/claimed only for migration.
// See docs/root-claim-compatibility.md for pinned source and defaults.
// Storage:
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
import { isFinneySs58Address } from "./account-balance.ts";
import { storageMapPrefix, bytesToHex } from "./twox-storage-key.ts";
import type { FieldSources } from "./field-provenance.ts";
import {
  type ChainNetworkId,
  networkKvKey,
  rpcUrlForNetwork,
} from "./chain-network.ts";

export const ROOT_CLAIM_KV_TTL = 120; // seconds
export const ROOT_CLAIM_NEGATIVE_KV_TTL = 10; // seconds
export const ROOT_CLAIM_RPC_TIMEOUT_MS = 5000;
const I96F32_SCALE = 2n ** 32n;
const I96F32_BYTES = 16;
const ACCOUNT_ID_BYTES = 32;
const MAX_HOTKEYS = 64;

function accountIdFromSs58(ss58: string): Uint8Array {
  const BASE58_ALPHABET =
    "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const INDEX = new Map([...BASE58_ALPHABET].map((c, i) => [c, i]));
  const bytes = [0];
  for (const char of ss58) {
    let carry = INDEX.get(char) ?? 0;
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

function blake2_128Concat(bytes: Uint8Array): Uint8Array {
  const hash = blake2b(bytes, { dkLen: 16 });
  const out = new Uint8Array(hash.length + bytes.length);
  out.set(hash, 0);
  out.set(bytes, hash.length);
  return out;
}

function u16LeBytes(netuid: number): Uint8Array {
  return Uint8Array.of(netuid & 0xff, (netuid >>> 8) & 0xff);
}

function accountScopedKey(itemName: string, accountId: Uint8Array): string {
  const prefix = storageMapPrefix("SubtensorModule", itemName);
  const hashed = blake2_128Concat(accountId);
  const out = new Uint8Array(prefix.length + hashed.length);
  out.set(prefix, 0);
  out.set(hashed, prefix.length);
  return bytesToHex(out);
}

function thresholdKey(netuid: number): string {
  const prefix = storageMapPrefix("SubtensorModule", "RootClaimableThreshold");
  const hashed = blake2_128Concat(u16LeBytes(netuid));
  const out = new Uint8Array(prefix.length + hashed.length);
  out.set(prefix, 0);
  out.set(hashed, prefix.length);
  return bytesToHex(out);
}

function claimedKey(
  netuid: number,
  hotAccountId: Uint8Array,
  coldAccountId: Uint8Array,
): string {
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

async function rpcCall(
  method: string,
  params: unknown[],
  timeoutMs: number,
  network?: ChainNetworkId,
): Promise<{ ok: boolean; result: unknown }> {
  try {
    const resp = await fetch(rpcUrlForNetwork(network), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!resp.ok) return { ok: false, result: undefined };
    const body: { error?: unknown; result?: unknown } = await resp.json();
    if (!body || body.error || !Object.hasOwn(body, "result")) {
      return { ok: false, result: undefined };
    }
    return { ok: true, result: body?.result };
  } catch {
    return { ok: false, result: undefined };
  }
}

function hexToBytes(hex: unknown): Uint8Array | null {
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

function readI128Le(bytes: Uint8Array, offset: number): bigint {
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

function readU128Le(bytes: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let i = I96F32_BYTES - 1; i >= 0; i -= 1) {
    value = (value << 8n) | BigInt(bytes[offset + i]);
  }
  return value;
}

/** I96F32 bits → float (value / 2^32). */
export function i96f32ToFloat(bits: bigint): number {
  const whole = bits / I96F32_SCALE;
  const remainder = bits % I96F32_SCALE;
  // Remainder is negative when bits is negative — Number(remainder)/scale preserves sign.
  return Number(whole) + Number(remainder) / Number(I96F32_SCALE);
}

function readCompactU32(
  bytes: Uint8Array,
  offset: number,
): { value: number; nextOffset: number } | null {
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

export type RootClaimType =
  | { kind: "Swap" }
  | { kind: "Keep" }
  | { kind: "KeepSubnets"; subnets: number[] };

/** Decode RootClaimTypeEnum SCALE. null on malformed. */
export function decodeRootClaimType(
  hex: string | null | undefined,
): RootClaimType | null {
  // Defaults belong to the verified runtime adapter, never to a raw decoder.
  if (hex == null) return null;
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
    const subnets: number[] = [];
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

export interface ClaimableMapEntry {
  netuid: number;
  claimable_rate: number;
}

/** Decode BTreeMap<NetUid, I96F32>. Only encoded empty maps yield []. */
export function decodeClaimableMap(
  hex: string | null | undefined,
): ClaimableMapEntry[] | null {
  if (hex == null) return null;
  const bytes = hexToBytes(hex);
  if (!bytes) return null;
  if (bytes.length === 0) return null;
  const lenResult = readCompactU32(bytes, 0);
  if (!lenResult) return null;
  const { value: count, nextOffset } = lenResult;
  const entries: ClaimableMapEntry[] = [];
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
export function decodeAccountIdVec(
  hex: string | null | undefined,
): string[] | null {
  if (hex == null) return null;
  const bytes = hexToBytes(hex);
  if (!bytes) return null;
  if (bytes.length === 0) return null;
  const lenResult = readCompactU32(bytes, 0);
  if (!lenResult) return null;
  const { value: count, nextOffset } = lenResult;
  const accounts: string[] = [];
  let offset = nextOffset;
  for (let i = 0; i < count; i += 1) {
    if (offset + ACCOUNT_ID_BYTES > bytes.length) return null;
    // The 32-byte slice below always satisfies encodeAccountId32's exactly-32-bytes
    // precondition (checked one line above), so it never returns null in practice.
    accounts.push(
      encodeAccountId32(bytes.slice(offset, offset + ACCOUNT_ID_BYTES))!,
    );
    offset += ACCOUNT_ID_BYTES;
  }
  if (offset !== bytes.length) return null;
  return accounts;
}

/** Decode I96F32; runtime-specific defaults are applied by the caller. */
export function decodeI96F32(hex: string | null | undefined): number | null {
  if (hex == null) return null;
  const bytes = hexToBytes(hex);
  if (!bytes || bytes.length !== I96F32_BYTES) return null;
  return i96f32ToFloat(readI128Le(bytes, 0));
}

/** Decode u128 ValueQuery (RootClaimed). */
export function decodeU128(hex: string | null | undefined): string | null {
  if (hex == null) return null;
  const bytes = hexToBytes(hex);
  if (!bytes || bytes.length !== I96F32_BYTES) return null;
  return readU128Le(bytes, 0).toString();
}

async function fetchStorage(
  key: string,
  timeoutMs: number,
  network: ChainNetworkId | undefined,
  blockHash: string,
): Promise<{ ok: boolean; hex: string | null | undefined }> {
  const result = await rpcCall(
    "state_getStorage",
    [key, blockHash],
    timeoutMs,
    network,
  );
  if (
    !result.ok ||
    (result.result !== null && typeof result.result !== "string")
  ) {
    return { ok: false, hex: undefined };
  }
  return {
    ok: true,
    hex: (result.result as string | null | undefined) ?? null,
  };
}

export interface RootClaimHotkeyEntry {
  netuid: number;
  claimable_rate: number;
  claimed: string;
  threshold: number;
}

export interface RootClaimHotkeyRow {
  hotkey: string;
  entries: RootClaimHotkeyEntry[];
}

/**
 * The cacheable body -- exactly what goes into KV. `field_sources` is
 * deliberately not part of it (#9108).
 */
export interface AccountRootClaimResultSnapshot {
  schema_version: 1;
  ss58: string;
  claim_type: RootClaimType | null;
  hotkeys: RootClaimHotkeyRow[] | null;
  queried_at: string;
  compatibility: RootClaimCompatibility;
}

/**
 * Live root-claim state for one Finney ss58 account. Uses METAGRAPH_CONTROL KV
 * (120s / 10s negative). On RPC failure: claim_type/hotkeys are null
 * (schema-stable), never throws.
 */
/**
 * Where each published value came from (#9108).
 *
 * `claim_type` uses one legacy storage value or an audited runtime default.
 * Each `hotkeys` row joins this account's `RootClaimableThreshold` and
 * `RootClaimed` entries per hotkey and netuid, so it assembles many reads.
 */
export interface AccountRootClaimResult extends AccountRootClaimResultSnapshot {
  field_sources: typeof ACCOUNT_ROOT_CLAIM_FIELD_SOURCES;
}

export const ACCOUNT_ROOT_CLAIM_FIELD_SOURCES = {
  claim_type: { kind: "reconstructed", storage: null },
  hotkeys: { kind: "reconstructed", storage: null },
  compatibility: { kind: "reconstructed", storage: null },
} as const satisfies FieldSources;

export interface RootClaimCompatibility {
  status: "legacy_supported" | "unsupported" | "unavailable";
  reason:
    | "root_reborn"
    | "unverified_runtime"
    | "rpc_or_decode_failure"
    | "legacy_limit_exceeded"
    | null;
  spec_name: string | null;
  spec_version: number | null;
  block_hash: string | null;
  claim_type_source: "storage" | "runtime_default" | null;
}

const BLOCK_HASH = /^0x[0-9a-fA-F]{64}$/;
const LEGACY_THRESHOLD_DEFAULT = 500_000;
const ZERO_U128 = "0x00000000000000000000000000000000";

async function rootClaimCompatibility(
  network?: ChainNetworkId,
): Promise<RootClaimCompatibility> {
  const head = await rpcCall(
    "chain_getFinalizedHead",
    [],
    ROOT_CLAIM_RPC_TIMEOUT_MS,
    network,
  );
  const blockHash =
    head.ok && typeof head.result === "string" && BLOCK_HASH.test(head.result)
      ? head.result
      : null;
  const version =
    blockHash === null
      ? null
      : await rpcCall(
          "state_getRuntimeVersion",
          [blockHash],
          ROOT_CLAIM_RPC_TIMEOUT_MS,
          network,
        );
  const runtime =
    version?.ok && version.result && typeof version.result === "object"
      ? (version.result as Record<string, unknown>)
      : null;
  const specName =
    typeof runtime?.specName === "string" ? runtime.specName : null;
  const specVersion =
    Number.isSafeInteger(runtime?.specVersion) &&
    (runtime!.specVersion as number) >= 0
      ? (runtime!.specVersion as number)
      : null;
  const identity = {
    spec_name: specName,
    spec_version: specVersion,
    block_hash: blockHash,
    claim_type_source: null,
  };
  if (specName === null || specVersion === null) {
    return {
      ...identity,
      status: "unavailable",
      reason: "rpc_or_decode_failure",
    };
  }
  if (specName !== "node-subtensor" || specVersion < 440) {
    return { ...identity, status: "unavailable", reason: "unverified_runtime" };
  }
  if (specVersion >= 441) {
    return { ...identity, status: "unsupported", reason: "root_reborn" };
  }
  return { ...identity, status: "legacy_supported", reason: null };
}

async function loadAccountRootClaimSnapshot(
  env: Env,
  ss58: string,
  network?: ChainNetworkId,
): Promise<AccountRootClaimResultSnapshot> {
  if (!isFinneySs58Address(ss58)) {
    throw new RangeError("ss58 must be a valid finney SS58 account address");
  }

  // Check runtime before cache lookup so a pre-upgrade record cannot survive
  // an upgrade. v2 also excludes entries written without compatibility checks.
  const compatibility = await rootClaimCompatibility(network);
  const cacheKey = networkKvKey(`root-claim:v2:${ss58}`, network);
  const kv = env?.METAGRAPH_CONTROL;
  if (kv?.get) {
    try {
      const cached = await kv.get<AccountRootClaimResultSnapshot>(cacheKey, {
        type: "json",
      });
      if (
        cached?.schema_version === 1 &&
        cached.ss58 === ss58 &&
        cached.compatibility?.spec_name === compatibility.spec_name &&
        cached.compatibility?.spec_version === compatibility.spec_version &&
        Object.hasOwn(cached, "claim_type") &&
        Object.hasOwn(cached, "hotkeys")
      ) {
        return cached;
      }
    } catch {
      // non-fatal
    }
  }

  const queriedAt = new Date().toISOString();
  async function finish(
    claimType: RootClaimType | null,
    hotkeys: RootClaimHotkeyRow[] | null,
    context = compatibility,
  ): Promise<AccountRootClaimResultSnapshot> {
    const payload: AccountRootClaimResultSnapshot = {
      schema_version: 1,
      ss58,
      claim_type: claimType,
      hotkeys,
      queried_at: queriedAt,
      compatibility: context,
    };
    if (kv?.put) {
      try {
        await kv.put(cacheKey, JSON.stringify(payload), {
          expirationTtl:
            context.status === "unavailable"
              ? ROOT_CLAIM_NEGATIVE_KV_TTL
              : ROOT_CLAIM_KV_TTL,
        });
      } catch {
        // non-fatal
      }
    }
    return payload;
  }
  const unavailable = (
    reason:
      | "rpc_or_decode_failure"
      | "legacy_limit_exceeded" = "rpc_or_decode_failure",
  ) => finish(null, null, { ...compatibility, status: "unavailable", reason });
  if (compatibility.status !== "legacy_supported") return finish(null, null);

  const blockHash = compatibility.block_hash!;
  const coldAccountId = accountIdFromSs58(ss58);
  const storage = (key: string) =>
    fetchStorage(key, ROOT_CLAIM_RPC_TIMEOUT_MS, network, blockHash);
  const [claimTypeRaw, stakingHotkeysRaw, ownedHotkeysRaw] = await Promise.all([
    storage(accountScopedKey("RootClaimType", coldAccountId)),
    storage(accountScopedKey("StakingHotkeys", coldAccountId)),
    storage(accountScopedKey("OwnedHotkeys", coldAccountId)),
  ]);
  if (!claimTypeRaw.ok || !stakingHotkeysRaw.ok || !ownedHotkeysRaw.ok)
    return unavailable();

  // ValueQuery defaults are justified only by this audited v440 adapter.
  // Undefined/malformed RPC results never reach these fallbacks.
  const claimType = decodeRootClaimType(claimTypeRaw.hex ?? "0x00");
  const stakingHotkeys = decodeAccountIdVec(stakingHotkeysRaw.hex ?? "0x00");
  const ownedHotkeys = decodeAccountIdVec(ownedHotkeysRaw.hex ?? "0x00");
  if (claimType === null || stakingHotkeys === null || ownedHotkeys === null)
    return unavailable();

  const hotkeyList = stakingHotkeys.length > 0 ? stakingHotkeys : ownedHotkeys;
  if (hotkeyList.length > MAX_HOTKEYS)
    return unavailable("legacy_limit_exceeded");
  const hotkeyRows = await Promise.all(
    hotkeyList.map(async (hotkey): Promise<RootClaimHotkeyRow | null> => {
      const hotAccountId = accountIdFromSs58(hotkey);
      const claimableRaw = await storage(
        accountScopedKey("RootClaimable", hotAccountId),
      );
      if (!claimableRaw.ok) return null;
      const rates = decodeClaimableMap(claimableRaw.hex ?? "0x00");
      if (rates === null) return null;
      const entries = await Promise.all(
        rates.map(async (row): Promise<RootClaimHotkeyEntry | null> => {
          const [claimedRaw, thresholdRaw] = await Promise.all([
            storage(claimedKey(row.netuid, hotAccountId, coldAccountId)),
            storage(thresholdKey(row.netuid)),
          ]);
          if (!claimedRaw.ok || !thresholdRaw.ok) return null;
          const claimed = decodeU128(claimedRaw.hex ?? ZERO_U128);
          const threshold =
            thresholdRaw.hex === null
              ? LEGACY_THRESHOLD_DEFAULT
              : decodeI96F32(thresholdRaw.hex);
          if (claimed === null || threshold === null) return null;
          return {
            netuid: row.netuid,
            claimable_rate: row.claimable_rate,
            claimed,
            threshold,
          };
        }),
      );
      if (entries.some((entry) => entry === null)) return null;
      return { hotkey, entries: entries as RootClaimHotkeyEntry[] };
    }),
  );
  if (hotkeyRows.some((row) => row === null)) return unavailable();
  return finish(claimType, hotkeyRows as RootClaimHotkeyRow[], {
    ...compatibility,
    claim_type_source:
      claimTypeRaw.hex === null ? "runtime_default" : "storage",
  });
}

/**
 * The served record: the body above plus its provenance map.
 *
 * Attached outside the loader so it never enters the KV blob, and so REST,
 * GraphQL and MCP all inherit it from one point rather than three call sites
 * kept in step by hand (#9108).
 */
export async function loadAccountRootClaim(
  env: Env,
  ss58: string,
  network?: ChainNetworkId,
): Promise<AccountRootClaimResult> {
  return {
    ...(await loadAccountRootClaimSnapshot(env, ss58, network)),
    field_sources: ACCOUNT_ROOT_CLAIM_FIELD_SOURCES,
  };
}
