// Live finney account TAO balance (free + reserved) via RPC (#1818).
// Shared by GET /api/v1/accounts/{ss58}/balance and MCP get_account_balance.

import { createHash } from "node:crypto";

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

function decodeBase58(value) {
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

function verifyFinneySs58Checksum(decoded) {
  if (decoded.length !== FINNEY_SS58_DECODED_LENGTH) return false;
  const body = decoded.subarray(
    0,
    decoded.length - FINNEY_SS58_CHECKSUM_LENGTH,
  );
  const checksum = decoded.subarray(
    decoded.length - FINNEY_SS58_CHECKSUM_LENGTH,
  );
  const hash = createHash("blake2b512")
    .update(Buffer.concat([Buffer.from(SS58_PREIMAGE), Buffer.from(body)]))
    .digest();
  return hash[0] === checksum[0] && hash[1] === checksum[1];
}

export function isFinneySs58Address(value) {
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

// Query live balance for one finney ss58. Uses METAGRAPH_CONTROL KV (60s TTL) when
// present; balance_tao is null on RPC failure (schema-stable, never throws).
export async function loadAccountBalance(env, ss58) {
  const cacheKey = `balance:${ss58}`;
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
  let balanceTao = null;
  let rpcOk = false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BALANCE_RPC_TIMEOUT_MS);
  try {
    const rpcResp = await fetch(FINNEY_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "system_account",
        params: [ss58],
      }),
    });
    if (rpcResp.ok) {
      const rpcBody = await rpcResp.json();
      const data = rpcBody?.result?.data;
      if (data && typeof data.free !== "undefined") {
        // Sum in BigInt rao space, then divide once — avoids float precision loss
        // on large on-chain balances before converting the remainder to TAO.
        const toRao = (v) =>
          typeof v === "string"
            ? BigInt(v)
            : BigInt(Math.trunc(Number(v ?? 0)));
        const totalRao = toRao(data.free) + toRao(data.reserved);
        balanceTao =
          Number(totalRao / 1_000_000_000n) +
          Number(totalRao % 1_000_000_000n) / 1e9;
        rpcOk = true;
      }
    }
  } catch {
    // RPC fetch failed — balance_tao stays null.
  } finally {
    clearTimeout(timeout);
  }

  const payload = {
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
