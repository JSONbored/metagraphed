// Live drand randomness-beacon status (#6730/#6731), via RPC. Shared by
// GET /api/v1/network/randomness.
//
// pallets/drand (pallets/drand/src/lib.rs) bridges drand's Quicknet into the
// runtime Randomness trait. Pulses land every ~3s -- far too high-frequency
// to event-log individually -- so this is a current-state SNAPSHOT of
// LastStoredRound/OldestStoredRound (both plain StorageValue<RoundNumber>,
// RoundNumber = u64), not a history feed. A commit-reveal weight-setter
// wants "what round will this reveal at, has that pulse landed" -- exactly
// what these two values answer.
//
// Storage keys = twox128("Drand") ++ twox128(<item name>), no further
// hashing (each is a StorageValue, not a map) -- computed via
// src/twox-storage-key.mjs's storageMapPrefix and hardcoded below, matching
// network-parameters.mjs's own precedent of precomputing fixed pallet/item
// prefixes rather than hashing on every request (the pallet/item name never
// changes). Cross-checked against that module's already-verified
// twox-storage-key.mjs output at write time -- see tests/randomness.test.mjs.

export const RANDOMNESS_KV_TTL = 30; // seconds -- pulses land ~3s apart, but this is a snapshot, not a feed
export const RANDOMNESS_NEGATIVE_KV_TTL = 10; // seconds
export const RANDOMNESS_RPC_TIMEOUT_MS = 5000;
const FINNEY_RPC_URL = "https://entrypoint-finney.opentensor.ai:443";

// twox128("Drand") ++ twox128("LastStoredRound").
const LAST_STORED_ROUND_STORAGE_KEY =
  "0xa285cdb66e8b8524ea70b1693c7b1e05087f3dd6e0ceded0e388dd34f810a73d";
// twox128("Drand") ++ twox128("OldestStoredRound").
const OLDEST_STORED_ROUND_STORAGE_KEY =
  "0xa285cdb66e8b8524ea70b1693c7b1e05bc30947083dc3a2cb9eb93b9db7c6fbd";

// Decode a "0x"-prefixed, 16-hex-char (8-byte) little-endian u64 into a
// BigInt. Returns null for anything else (malformed/short/absent result).
// Byte-for-byte copy of network-parameters.mjs's own decodeLeU64, per this
// codebase's per-module small-codec-helper convention.
function decodeLeU64(hex) {
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]{16}$/.test(hex)) {
    return null;
  }
  let value = 0n;
  for (let i = hex.length - 2; i >= 2; i -= 2) {
    value = (value << 8n) | BigInt(parseInt(hex.slice(i, i + 2), 16));
  }
  return value;
}

// One raw state_getStorage read, decoded to a BigInt. null on any failure
// (non-ok response, timeout, malformed result); a genuinely unset storage
// result (raw null) reads as a real 0n, not a failure -- mirrors
// network-parameters.mjs's own unset-storage handling.
async function fetchStorageU64(storageKey, timeoutMs) {
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
    if (!rpcResp.ok) return null;
    const rpcBody = await rpcResp.json();
    const raw = rpcBody?.result;
    const bits = decodeLeU64(raw);
    if (bits != null) return bits;
    if (raw === null) return 0n;
    return null;
  } catch {
    return null;
  }
}

// Query the live randomness-beacon status. Uses METAGRAPH_CONTROL KV (30s
// TTL) when present; each field is independently null on its own RPC
// failure (schema-stable, never throws) -- two parallel reads against the
// same endpoint, matching network-parameters.mjs's own batched-but-
// independent-failure shape. Positive-caches only when both succeed, so a
// partial failure doesn't cache a stale-looking result for the full TTL.
export async function loadRandomnessStatus(env) {
  const cacheKey = "network:randomness";
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
  const [lastStoredRoundBits, oldestStoredRoundBits] = await Promise.all([
    fetchStorageU64(LAST_STORED_ROUND_STORAGE_KEY, RANDOMNESS_RPC_TIMEOUT_MS),
    fetchStorageU64(OLDEST_STORED_ROUND_STORAGE_KEY, RANDOMNESS_RPC_TIMEOUT_MS),
  ]);

  const lastStoredRound =
    lastStoredRoundBits != null ? Number(lastStoredRoundBits) : null;
  const oldestStoredRound =
    oldestStoredRoundBits != null ? Number(oldestStoredRoundBits) : null;
  const rpcOk = lastStoredRound != null && oldestStoredRound != null;
  // How many pulses are currently retained on-chain, inclusive of both
  // ends -- null unless both bounds resolved (never a misleading partial
  // span from mixing one live value with a stale/absent other).
  const storedRoundSpan = rpcOk
    ? lastStoredRound - oldestStoredRound + 1
    : null;

  const payload = {
    schema_version: 1,
    last_stored_round: lastStoredRound,
    oldest_stored_round: oldestStoredRound,
    stored_round_span: storedRoundSpan,
    queried_at: queriedAt,
  };

  if (kv?.put) {
    try {
      await kv.put(cacheKey, JSON.stringify(payload), {
        expirationTtl: rpcOk ? RANDOMNESS_KV_TTL : RANDOMNESS_NEGATIVE_KV_TTL,
      });
    } catch {
      // KV write failure is non-fatal.
    }
  }

  return payload;
}
