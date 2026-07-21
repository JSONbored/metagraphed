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
import { blake2b } from "@noble/hashes/blake2.js";

const SS58_BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const SS58_BASE58_INDEX = new Map(
  [...SS58_BASE58_ALPHABET].map((char, index) => [char, index]),
);
const FINNEY_SS58_PREFIX = 42;
const FINNEY_SS58_MIN_LENGTH = 47;
const FINNEY_SS58_MAX_LENGTH = 48;
const FINNEY_SS58_DECODED_LENGTH = 35;
const FINNEY_SS58_CHECKSUM_LENGTH = 2; // prefix < 64 → 2-byte SS58 checksum
const SS58_PREIMAGE = new TextEncoder().encode("SS58PRE");
export const BALANCE_KV_TTL = 60; // seconds
export const BALANCE_NEGATIVE_KV_TTL = 10; // seconds
export const BALANCE_RPC_TIMEOUT_MS = 5000;
const FINNEY_RPC_URL = "https://entrypoint-finney.opentensor.ai:443";

// System::Account(AccountId) storage prefix = twox128("System") ++ twox128("Account").
// Hard-coded: both halves are fixed runtime constants (the pallet/storage names
// never change), and computing them would need an xxhash dependency this repo
// doesn't carry — whereas blake2_128Concat below reuses the @noble/hashes blake2b
// already imported for the SS58 checksum. Verified against a live finney
// state_getStorage response.
const SYSTEM_ACCOUNT_STORAGE_PREFIX =
  "26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9";
const ACCOUNT_ID_LENGTH = 32;
// SCALE AccountInfo: nonce/consumers/providers/sufficients (u32 LE each = 16
// bytes), then AccountData whose first two fields are free + reserved (u128 LE
// each). Only free+reserved are read; the trailing frozen/flags (or legacy
// misc_frozen/fee_frozen) fields are ignored, so both AccountData layouts decode.
const ACCOUNT_DATA_FREE_OFFSET = 16;
const ACCOUNT_DATA_RESERVED_OFFSET = 32;
const U128_BYTES = 16;
const RAO_PER_TAO = 1_000_000_000n;

function decodeBase58(value: string): Uint8Array | null {
  const bytes = [0];
  for (const char of value) {
    const carryStart = SS58_BASE58_INDEX.get(char);
    if (carryStart == null) return null;
    let carry = carryStart;
    for (let index = 0; index < bytes.length; index += 1) {
      carry += bytes[index] * 58;
      bytes[index] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const char of value) {
    if (char !== "1") break;
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

function verifyFinneySs58Checksum(decoded: Uint8Array): boolean {
  if (decoded.length !== FINNEY_SS58_DECODED_LENGTH) return false;
  const body = decoded.subarray(
    0,
    decoded.length - FINNEY_SS58_CHECKSUM_LENGTH,
  );
  const checksum = decoded.subarray(
    decoded.length - FINNEY_SS58_CHECKSUM_LENGTH,
  );
  const preimage = new Uint8Array(SS58_PREIMAGE.length + body.length);
  preimage.set(SS58_PREIMAGE, 0);
  preimage.set(body, SS58_PREIMAGE.length);
  const hash = blake2b(preimage, { dkLen: 64 });
  return hash[0] === checksum[0] && hash[1] === checksum[1];
}

export function isFinneySs58Address(value: string): boolean {
  if (
    value.length < FINNEY_SS58_MIN_LENGTH ||
    value.length > FINNEY_SS58_MAX_LENGTH
  ) {
    return false;
  }

  const decoded = decodeBase58(value);
  return (
    decoded?.length === FINNEY_SS58_DECODED_LENGTH &&
    decoded[0] === FINNEY_SS58_PREFIX &&
    verifyFinneySs58Checksum(decoded)
  );
}

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

function readU128Le(bytes: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let index = U128_BYTES - 1; index >= 0; index -= 1) {
    value = (value << 8n) | BigInt(bytes[offset + index]);
  }
  return value;
}

// The 32-byte AccountId inside a finney SS58 (prefix byte, then AccountId32, then
// the 2-byte checksum). Callers shape-check the address with isFinneySs58Address.
function accountIdFromSs58(ss58: string): Uint8Array | null {
  const decoded = decodeBase58(ss58);
  if (decoded?.length !== FINNEY_SS58_DECODED_LENGTH) return null;
  return decoded.subarray(1, 1 + ACCOUNT_ID_LENGTH);
}

// System::Account(accountId) = twox128("System") ++ twox128("Account")
// ++ blake2_128Concat(accountId), where blake2_128Concat(x) = blake2b-128(x) ++ x.
export function systemAccountStorageKey(accountId: Uint8Array): string {
  return `0x${SYSTEM_ACCOUNT_STORAGE_PREFIX}${toHex(
    blake2b(accountId, { dkLen: 16 }),
  )}${toHex(accountId)}`;
}

interface JsonRpcResponseLike {
  error?: unknown;
  result?: unknown;
}

// free + reserved (in rao) from a state_getStorage AccountInfo response, or null
// when the node reported an error or returned an undecodable blob.
export function accountInfoTotalRao(
  rpcBody: JsonRpcResponseLike | null | undefined,
): bigint | null {
  if (!rpcBody || rpcBody.error) return null;
  const result = rpcBody.result;
  // A never-seen account has no System::Account entry at all — that is a
  // successful read of a zero balance, not an RPC failure.
  if (result == null) return 0n;
  if (typeof result !== "string") return null;
  const bytes = hexToBytes(result);
  if (!bytes || bytes.length < ACCOUNT_DATA_RESERVED_OFFSET + U128_BYTES) {
    return null;
  }
  return (
    readU128Le(bytes, ACCOUNT_DATA_FREE_OFFSET) +
    readU128Le(bytes, ACCOUNT_DATA_RESERVED_OFFSET)
  );
}

export interface AccountBalanceResult {
  schema_version: 1;
  ss58: string;
  balance_tao: number | null;
  queried_at: string;
}

// Query live balance for one finney ss58. Uses METAGRAPH_CONTROL KV (60s TTL) when
// present; balance_tao is null on RPC failure (schema-stable, never throws).
export async function loadAccountBalance(
  env: Env,
  ss58: string,
): Promise<AccountBalanceResult> {
  const cacheKey = `balance:${ss58}`;
  const kv = env?.METAGRAPH_CONTROL;

  if (kv?.get) {
    try {
      const cached = await kv.get(cacheKey, { type: "json" });
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
    const rpcResp = await fetch(FINNEY_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(BALANCE_RPC_TIMEOUT_MS),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "state_getStorage",
        params: [systemAccountStorageKey(accountId)],
      }),
    });
    if (rpcResp.ok) {
      const totalRao = accountInfoTotalRao(
        (await rpcResp.json()) as JsonRpcResponseLike,
      );
      if (totalRao != null) {
        // Sum in BigInt rao space, then divide once — avoids float precision loss
        // on large on-chain balances before converting the remainder to TAO.
        balanceTao =
          Number(totalRao / RAO_PER_TAO) + Number(totalRao % RAO_PER_TAO) / 1e9;
        rpcOk = true;
      }
    }
  } catch {
    // RPC fetch failed — balance_tao stays null.
  }

  const payload: AccountBalanceResult = {
    schema_version: 1,
    ss58,
    balance_tao: balanceTao,
    queried_at: queriedAt,
  };

  if (kv?.put) {
    try {
      await kv.put(cacheKey, JSON.stringify(payload), {
        expirationTtl: rpcOk ? BALANCE_KV_TTL : BALANCE_NEGATIVE_KV_TTL,
      });
    } catch {
      // KV write failure is non-fatal.
    }
  }

  return payload;
}
