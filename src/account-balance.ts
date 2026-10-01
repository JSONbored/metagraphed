// Live finney account TAO balance (free + reserved) via RPC (#1818).
// Shared by GET /api/v1/accounts/{ss58}/balance and MCP get_account_balance.

// node:crypto's createHash("blake2b512") is NOT implemented in the Cloudflare
// Workers runtime (confirmed live: throws "Error: Digest method not
// supported" in workerd, even though the identical call works fine under
// Node.js/vitest, which run this code against real Node -- the local/CI test
// suite never caught this because it never runs against workerd). Web
// Crypto's SubtleCrypto.digest() has no BLAKE2b algorithm either. @noble/hashes
// is audited, zero-dependency, pure JS, and verified working in workerd
// (wrangler dev) with output identical to node:crypto's blake2b512.
import { readLiveRpcCache, writeLiveRpcCache } from "./live-rpc-cache.ts";
import { blake2b } from "@noble/hashes/blake2.js";
import { chainRpc } from "./chain-rpc.ts";
import { accountIdFromSs58 } from "./finney-ss58.ts";
export { isFinneySs58Address } from "./finney-ss58.ts";
import type { FieldSources } from "./field-provenance.ts";
import { RAO_PER_TAO } from "./lib/rao.ts";
import {
  type ChainNetworkId,
  networkKvKey,
  rpcUrlForNetwork,
} from "./chain-network.ts";

export const BALANCE_KV_TTL = 60; // seconds
// Logical retry seconds; physical KV expiration is at least 60 seconds.
export const BALANCE_NEGATIVE_KV_TTL = 10;
export const BALANCE_RPC_TIMEOUT_MS = 5000;

// System::Account(AccountId) storage prefix = twox128("System") ++ twox128("Account").
// Hard-coded: both halves are fixed runtime constants (the pallet/storage names
// never change), and computing them would need an xxhash dependency this repo
// doesn't carry — whereas blake2_128Concat below reuses the @noble/hashes blake2b
// used for the SS58 checksum in finney-ss58.ts. Verified against a live finney
// state_getStorage response.
const SYSTEM_ACCOUNT_STORAGE_PREFIX =
  "26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9";
// SCALE AccountInfo: nonce/consumers/providers/sufficients (u32 LE each = 16
// bytes), then AccountData. subtensor's Balance type is u64, so a live finney
// blob is 56 bytes: free u64@16, reserved u64@24, frozen u64@32, flags u128@40
// (verified against a live state_getStorage response). Generic-Substrate
// chains use Balance = u128 (free u128@16, reserved u128@32; 80 bytes with
// frozen+flags). Decoding finney's 56-byte blob with the u128 offsets spans
// free+reserved in a single read, so any account with reserved > 0 returned
// ~1e18 "tao" (#8239) — the layout must be picked by blob length.
const ACCOUNT_INFO_HEADER_BYTES = 16;
const U64_BYTES = 8;
const U128_BYTES = 16;
// header + free/reserved/frozen (u64 each) + flags (u128) — live finney shape.
const ACCOUNT_INFO_U64_LENGTH =
  ACCOUNT_INFO_HEADER_BYTES + 3 * U64_BYTES + U128_BYTES; // 56
// header + free + reserved (u128 each) — the minimum readable u128-layout blob.
const ACCOUNT_INFO_U128_MIN_LENGTH = ACCOUNT_INFO_HEADER_BYTES + 2 * U128_BYTES; // 48
// header + free/reserved/frozen/flags (u128 each) — a full u128 AccountData.
const ACCOUNT_INFO_U128_FULL_LENGTH =
  ACCOUNT_INFO_HEADER_BYTES + 4 * U128_BYTES; // 80
function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function hexToBytes(hex: string): Uint8Array | null {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (body.length === 0 || body.length % 2 !== 0) return null;
  const bytes = new Uint8Array(body.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = Number.parseInt(body.slice(index * 2, index * 2 + 2), 16);
    if (Number.isNaN(byte)) return null;
    bytes[index] = byte;
  }
  return bytes;
}

function readUintLe(bytes: Uint8Array, offset: number, width: number): bigint {
  let value = 0n;
  for (let index = width - 1; index >= 0; index -= 1) {
    value = (value << 8n) | BigInt(bytes[offset + index]);
  }
  return value;
}

// System::Account(accountId) = twox128("System") ++ twox128("Account")
// ++ blake2_128Concat(accountId), where blake2_128Concat(x) = blake2b-128(x) ++ x.
export function systemAccountStorageKey(accountId: Uint8Array): string {
  return `0x${SYSTEM_ACCOUNT_STORAGE_PREFIX}${toHex(
    blake2b(accountId, { dkLen: 16 }),
  )}${toHex(accountId)}`;
}

// free + reserved (in rao) from a state_getStorage AccountInfo RESULT, or null
// when the node returned an undecodable blob.
//
// TAKES THE RESULT, NOT THE ENVELOPE. This used to accept `{ result, error }`
// and hand-check `error`, which meant the envelope was cast here
// (`as JsonRpcResponseLike`) rather than parsed — the last site in the repo
// still doing that after #11216 claimed the three remaining ones. `chainRpc`
// safeParses the envelope and throws on `error`, so by the time a value
// reaches this function it is a validated `result` and nothing else. What is
// left here is what this function was always really doing: decoding a SCALE
// blob.
export function accountInfoTotalRao(result: unknown): bigint | null {
  // A never-seen account has no System::Account entry at all — that is a
  // successful read of a zero balance, not an RPC failure. `undefined` reaches
  // here for an envelope with no `result` key, which the schema allows.
  if (result == null) return 0n;
  if (typeof result !== "string") return null;
  const bytes = hexToBytes(result);
  if (!bytes) return null;
  // Pick the AccountData layout by blob length (see the constants above):
  // a full u128 AccountData first (>=80 bytes), then finney's u64 layout
  // (56..79 — the live-chain shape), then the minimal free+reserved u128
  // pair (48..55) for compatibility. Anything shorter is undecodable.
  if (bytes.length >= ACCOUNT_INFO_U128_FULL_LENGTH) {
    return (
      readUintLe(bytes, ACCOUNT_INFO_HEADER_BYTES, U128_BYTES) +
      readUintLe(bytes, ACCOUNT_INFO_HEADER_BYTES + U128_BYTES, U128_BYTES)
    );
  }
  if (bytes.length >= ACCOUNT_INFO_U64_LENGTH) {
    return (
      readUintLe(bytes, ACCOUNT_INFO_HEADER_BYTES, U64_BYTES) +
      readUintLe(bytes, ACCOUNT_INFO_HEADER_BYTES + U64_BYTES, U64_BYTES)
    );
  }
  if (bytes.length >= ACCOUNT_INFO_U128_MIN_LENGTH) {
    return (
      readUintLe(bytes, ACCOUNT_INFO_HEADER_BYTES, U128_BYTES) +
      readUintLe(bytes, ACCOUNT_INFO_HEADER_BYTES + U128_BYTES, U128_BYTES)
    );
  }
  return null;
}

/**
 * The cacheable body -- exactly what goes into KV. `field_sources` is
 * deliberately not part of it (#9108).
 */
export interface AccountBalanceResultSnapshot {
  schema_version: 1;
  ss58: string;
  balance_tao: number | null;
  queried_at: string;
}

// Query live balance for one finney ss58. Uses METAGRAPH_CONTROL KV (60s TTL) when
// present; balance_tao is null on RPC failure (schema-stable, never throws).
/**
 * Where each published value came from (#9108).
 *
 * One field, one read: the account's free + reserved balance off
 * `System::Account`. Not the Subtensor pallet -- this is the base-layer
 * balance, which is why the item names `System` rather than `SubtensorModule`,
 * and why it is real TAO rather than any subnet's alpha.
 */
export interface AccountBalanceResult extends AccountBalanceResultSnapshot {
  field_sources: typeof ACCOUNT_BALANCE_FIELD_SOURCES;
}

export const ACCOUNT_BALANCE_FIELD_SOURCES = {
  balance_tao: { kind: "measured", storage: "System.Account" },
} as const satisfies FieldSources;

async function loadAccountBalanceSnapshot(
  env: Env,
  ss58: string,
  network?: ChainNetworkId,
): Promise<AccountBalanceResultSnapshot> {
  // The same address holds different balances on each chain, and a testnet
  // developer checking whether they can afford a registration must never be
  // shown a finney balance.
  const cacheKey = networkKvKey(`balance:${ss58}`, network);
  const kv = env?.METAGRAPH_CONTROL;

  if (typeof kv?.get === "function") {
    try {
      const cached = await readLiveRpcCache(kv, cacheKey);
      if (cached) return cached as AccountBalanceResult;
    } catch {
      // KV read failure is non-fatal — fall through to the live RPC.
    }
  }

  const queriedAt = new Date().toISOString();
  let balanceTao: number | null = null;
  let rpcOk = false;

  try {
    // `system_account` is NOT a real RPC method (finney answers -32601 "Method
    // not found"), so this route returned null for every address (#6506). Read
    // the System::Account storage entry directly instead — the same thing the
    // absent method would have wrapped.
    // Non-null: callers shape-check `ss58` with isFinneySs58Address first (see
    // this file's own header comment), so accountIdFromSs58 only ever returns
    // null here for an address this function is never actually called with --
    // a violation would throw below, caught by the same try/catch as any
    // other RPC failure, leaving balance_tao null (unchanged behavior).
    const accountId = accountIdFromSs58(ss58)!;
    // THROUGH THE VALIDATED CLIENT, not a hand-built envelope. `chainRpc`
    // safeParses the response and throws on a non-2xx, a body that is not JSON,
    // a body that is not a JSON-RPC envelope, or an envelope carrying `error` —
    // every one of which this site previously either ignored (`rpcResp.ok`) or
    // read off a cast. The catch below already turns any of them into
    // "balance_tao stays null", so the failure behaviour is unchanged; what
    // changes is that a proxy answering 200 with HTML can no longer reach the
    // decoder as a value-shaped object.
    const result = await chainRpc(
      rpcUrlForNetwork(network),
      "state_getStorage",
      [systemAccountStorageKey(accountId)],
      { timeoutMs: BALANCE_RPC_TIMEOUT_MS },
    );
    const totalRao = accountInfoTotalRao(result);
    if (totalRao != null) {
      // Sum in BigInt rao space, then divide once — avoids float precision loss
      // on large on-chain balances before converting the remainder to TAO.
      balanceTao =
        Number(totalRao / RAO_PER_TAO) + Number(totalRao % RAO_PER_TAO) / 1e9;
      rpcOk = true;
    }
  } catch {
    // RPC fetch failed, the transport lied, or the node reported an error —
    // balance_tao stays null.
  }

  const payload: AccountBalanceResultSnapshot = {
    schema_version: 1,
    ss58,
    balance_tao: balanceTao,
    queried_at: queriedAt,
  };

  if (typeof kv?.put === "function") {
    try {
      await writeLiveRpcCache(kv, cacheKey, payload, {
        ttlSeconds: rpcOk ? BALANCE_KV_TTL : BALANCE_NEGATIVE_KV_TTL,
        negative: !rpcOk,
      });
    } catch {
      // KV write failure is non-fatal.
    }
  }

  return payload;
}

/**
 * The served record: the body above plus its provenance map.
 *
 * Attached outside the loader so it never enters the KV blob, and so REST,
 * GraphQL and MCP all inherit it from one point rather than three call sites
 * kept in step by hand (#9108).
 */
export async function loadAccountBalance(
  env: Env,
  ss58: string,
  network?: ChainNetworkId,
): Promise<AccountBalanceResult> {
  return {
    ...(await loadAccountBalanceSnapshot(env, ss58, network)),
    field_sources: ACCOUNT_BALANCE_FIELD_SOURCES,
  };
}
