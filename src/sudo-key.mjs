// Live finney Sudo::Key holder via RPC (#4310/2.4, re-scoped from the original
// Senate/Council membership framing — see #4310's audit; subtensor has no such
// pallet). Sudo::Key is a plain StorageValue (Optional<AccountId32>), so its
// storage key is the fixed twox128("Sudo") ++ twox128("Key") prefix with no
// further hashing — confirmed live against finney (bittensor 10.5.0,
// substrate.create_storage_key("Sudo", "Key")), so it's hardcoded rather than
// computed at runtime. Mirrors src/account-balance.mjs's live-RPC + KV-cache
// shape for GET /api/v1/accounts/{ss58}/balance.

import { createHash } from "node:crypto";

const SUDO_KEY_STORAGE_KEY =
  "0x5c0d1176a568c1f92944340dbfed9e9c530ebca703c85910e7164cb7d1c9e47b";
export const SUDO_KEY_KV_TTL = 3600; // seconds — the sudo key changes extremely rarely
export const SUDO_KEY_NEGATIVE_KV_TTL = 10; // seconds
export const SUDO_KEY_RPC_TIMEOUT_MS = 5000;
const FINNEY_RPC_URL = "https://entrypoint-finney.opentensor.ai:443";

const SS58_BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const FINNEY_SS58_PREFIX = 42;
const SS58_PREIMAGE = new TextEncoder().encode("SS58PRE");

// The general base58 "leading zero byte -> leading '1' character" convention
// (account-balance.mjs's decodeBase58 handles the inverse) doesn't apply to
// this call site: the one caller always passes [prefix, ...accountId,
// checksumHi, checksumLo], and FINNEY_SS58_PREFIX (42) is never zero, so the
// byte array this function ever sees can't start with a zero byte.
function encodeBase58(bytes) {
  let num = 0n;
  for (const b of bytes) num = (num << 8n) | BigInt(b);
  let out = "";
  while (num > 0n) {
    const rem = num % 58n;
    out = SS58_BASE58_ALPHABET[Number(rem)] + out;
    num /= 58n;
  }
  return out;
}

// AccountId32 -> SS58 (finney prefix 42): payload = prefix_byte + 32 account
// bytes, checksum = blake2b512("SS58PRE" + payload)[0:2], address =
// base58(payload + checksum). The exact inverse of account-balance.mjs's
// verifyFinneySs58Checksum (decode direction) — golden-value-tested against
// the live-confirmed 2026-07-08 Sudo key in tests/sudo-key.test.mjs. Uses
// node:crypto's blake2b512 like account-balance.mjs — Web Crypto's
// SubtleCrypto.digest() has no BLAKE2b algorithm.
function ss58Encode(accountIdBytes, prefix = FINNEY_SS58_PREFIX) {
  const payload = new Uint8Array(1 + accountIdBytes.length);
  payload[0] = prefix;
  payload.set(accountIdBytes, 1);
  const hash = createHash("blake2b512")
    .update(Buffer.concat([Buffer.from(SS58_PREIMAGE), Buffer.from(payload)]))
    .digest();
  const full = new Uint8Array(payload.length + 2);
  full.set(payload, 0);
  full[payload.length] = hash[0];
  full[payload.length + 1] = hash[1];
  return encodeBase58(full);
}

// The one call site already validated a "0x"-prefixed 64-hex-char string via
// regex, so this only ever strips that guaranteed prefix — not a general
// hex-or-0x-hex parser.
function hexToBytes(hex) {
  const clean = hex.slice(2);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

// Query the live Sudo::Key holder. Uses METAGRAPH_CONTROL KV (1h TTL, same
// binding as loadAccountBalance) when present; hotkey is null on RPC failure
// or an unset sudo key (Optional<AccountId>) — schema-stable, never throws.
export async function loadSudoKey(env) {
  const cacheKey = "sudo:key";
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
  let hotkey = null;
  let rpcOk = false;

  try {
    const rpcResp = await fetch(FINNEY_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(SUDO_KEY_RPC_TIMEOUT_MS),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "state_getStorage",
        params: [SUDO_KEY_STORAGE_KEY],
      }),
    });
    if (rpcResp.ok) {
      const rpcBody = await rpcResp.json();
      const raw = rpcBody?.result;
      if (typeof raw === "string" && /^0x[0-9a-fA-F]{64}$/.test(raw)) {
        hotkey = ss58Encode(hexToBytes(raw));
        rpcOk = true;
      } else if (raw === null) {
        // Storage genuinely unset (sudo renounced) — a valid, not-failed result.
        rpcOk = true;
      }
    }
  } catch {
    // RPC fetch failed — hotkey stays null.
  }

  const payload = {
    schema_version: 1,
    hotkey,
    queried_at: queriedAt,
  };

  if (kv?.put) {
    try {
      await kv.put(cacheKey, JSON.stringify(payload), {
        expirationTtl: rpcOk ? SUDO_KEY_KV_TTL : SUDO_KEY_NEGATIVE_KV_TTL,
      });
    } catch {
      // KV write failure is non-fatal.
    }
  }

  return payload;
}
