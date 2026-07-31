// Live global Subtensor protocol/governance parameters (#6343), via RPC.
// Shared by GET /api/v1/network/parameters.
//
// TaoWeight/StakeThreshold/PendingChildKeyCooldown are real, governance-
// adjustable, network-wide values with no per-subnet dimension -- plain
// StorageValues, same shape as Sudo::Key (src/sudo-key.ts), just three of
// them instead of one. Batched into ONE cached response rather than three
// separate routes: callers doing capital/validator-ops planning need all
// three together, and they share the same freshness profile (governance-
// adjustable, changes rarely, not chain-derived per-block state like
// subnet-burn.ts's Burn(netuid)).
//
// Storage keys = twox128("SubtensorModule") ++ twox128(<item name>), no
// further hashing (each is a StorageValue, not a map) -- hardcoded below,
// matching sudo-key.ts's own precedent, since twox128 needs XXHash64, not
// in Node's built-in crypto. Verified live against finney (bittensor 10.5.0,
// substrate.create_storage_key("SubtensorModule", <item>)) and via raw
// state_getStorage RPC calls, 2026-07-17:
//   TaoWeight raw result 0x7a14ae47e17a142e -> a U64F64 fixed-point ratio
//     (bits/2**64 = 0.18004..., matching live TaoWeight ~0.18 at the time
//     the underlying issue was filed -- this is governance-adjustable and
//     will drift, the fixed-point DECODING is what's verified, not the
//     specific value).
//   StakeThreshold raw result 0x0010a5d4e8000000 -> a plain u64 rao amount
//     (1e12 rao = 1000 TAO exactly).
//   PendingChildKeyCooldown raw result 0x201c000000000000 -> a plain u64
//     block count (7200, no TAO conversion).

import { blockEmissionForIssuance } from "./block-emission.ts";

export const NETWORK_PARAMETERS_KV_TTL = 300; // seconds -- governance-adjustable, changes rarely but not never
export const NETWORK_PARAMETERS_NEGATIVE_KV_TTL = 10; // seconds
export const NETWORK_PARAMETERS_RPC_TIMEOUT_MS = 5000;
const FINNEY_RPC_URL = "https://entrypoint-finney.opentensor.ai:443";

// twox128("SubtensorModule") ++ twox128("TaoWeight").
const TAO_WEIGHT_STORAGE_KEY =
  "0x658faa385070e074c85bf6b568cf05556b2684762c3b1e22ffb4a92939298741";
// twox128("SubtensorModule") ++ twox128("StakeThreshold").
const STAKE_THRESHOLD_STORAGE_KEY =
  "0x658faa385070e074c85bf6b568cf0555782d99ebaa64a1ba18b3e8cda1047327";
// twox128("SubtensorModule") ++ twox128("PendingChildKeyCooldown").
const PENDING_CHILDKEY_COOLDOWN_STORAGE_KEY =
  "0x658faa385070e074c85bf6b568cf0555503e4fe5f139cae8b9d045e82e1c83a2";
// twox128("SubtensorModule") ++ twox128("TotalIssuance"). #8747: block
// emission is DERIVED from this, never read from the `BlockEmission` storage
// item -- see src/block-emission.ts for why that item is stale and what
// reading it costs.
const TOTAL_ISSUANCE_STORAGE_KEY =
  "0x658faa385070e074c85bf6b568cf055557c875e4cff74148e4628f264b974c80";

// Decode a "0x"-prefixed, 16-hex-char (8-byte) little-endian u64 into a
// BigInt. Returns null for anything else (malformed/short/absent result).
function decodeLeU64(hex: unknown): bigint | null {
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]{16}$/.test(hex)) {
    return null;
  }
  let value = 0n;
  for (let i = hex.length - 2; i >= 2; i -= 2) {
    value = (value << 8n) | BigInt(parseInt(hex.slice(i, i + 2), 16));
  }
  return value;
}

// BigInt rao -> Number TAO, split in BigInt space first to avoid float
// precision loss (mirrors subnet-burn.ts's / subnet-recycled.ts's
// identical conversion).
function raoToTao(rao: bigint): number {
  return Number(rao / 1_000_000_000n) + Number(rao % 1_000_000_000n) / 1e9;
}

// U64F64 fixed-point ratio (0..u64::MAX representing 0.0..1.0) -> a plain
// 0..1 float. Split whole/remainder in BigInt space first for the same
// precision reason raoToTao does -- a naive Number(bits)/Number(2**64)
// routes the numerator through double rounding before dividing at all.
const U64F64_SCALE = 2n ** 64n;
function u64f64ToFloat(bits: bigint): number {
  const whole = bits / U64F64_SCALE;
  const remainder = bits % U64F64_SCALE;
  return Number(whole) + Number(remainder) / Number(U64F64_SCALE);
}

// One raw state_getStorage read, decoded to a BigInt. null on any failure
// (non-ok response, timeout, malformed result); a genuinely unset storage
// result (raw null) reads as a real 0n, not a failure -- mirrors subnet-
// recycled.mjs's / subnet-burn.ts's own unset-storage handling.
async function fetchStorageU64(
  storageKey: string,
  timeoutMs: number,
): Promise<bigint | null> {
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
    const rpcBody = (await rpcResp.json()) as Record<string, unknown>;
    const raw = rpcBody?.result;
    const bits = decodeLeU64(raw);
    if (bits != null) return bits;
    if (raw === null) return 0n;
    return null;
  } catch {
    return null;
  }
}

export interface NetworkParameters {
  schema_version: 1;
  tao_weight: number | null;
  stake_threshold_tao: number | null;
  pending_childkey_cooldown_blocks: number | null;
  /** Total issuance in TAO, the input the block-emission halving is derived from (#8747). */
  total_issuance_tao: number | null;
  /** TAO emitted per block right now. Derived, never read from `BlockEmission`. */
  block_emission_tao: number | null;
  /** How many halvings have occurred. A step function, never interpolated. */
  block_emission_halvings: number | null;
  queried_at: string;
}

// Query the live global governance parameters. Uses METAGRAPH_CONTROL KV
// (300s TTL) when present; each field is independently null on its own RPC
// failure (schema-stable, never throws) -- three parallel reads against the
// same endpoint, not a single combined query (no batched-storage RPC method
// this codebase already relies on elsewhere). Positive-caches only when all
// three succeed, so a partial failure doesn't cache a stale-looking result
// for the full TTL.
export async function loadNetworkParameters(
  env: Env,
): Promise<NetworkParameters> {
  const cacheKey = "network:parameters";
  const kv = env?.METAGRAPH_CONTROL;

  if (kv?.get) {
    try {
      const cached = await kv.get<NetworkParameters>(cacheKey, {
        type: "json",
      });
      if (cached) return cached;
    } catch {
      // KV read failure is non-fatal — fall through to the live RPC.
    }
  }

  const queriedAt = new Date().toISOString();
  const [
    taoWeightBits,
    stakeThresholdRao,
    pendingChildKeyCooldownBits,
    totalIssuanceRao,
  ] = await Promise.all([
    fetchStorageU64(TAO_WEIGHT_STORAGE_KEY, NETWORK_PARAMETERS_RPC_TIMEOUT_MS),
    fetchStorageU64(
      STAKE_THRESHOLD_STORAGE_KEY,
      NETWORK_PARAMETERS_RPC_TIMEOUT_MS,
    ),
    fetchStorageU64(
      PENDING_CHILDKEY_COOLDOWN_STORAGE_KEY,
      NETWORK_PARAMETERS_RPC_TIMEOUT_MS,
    ),
    fetchStorageU64(
      TOTAL_ISSUANCE_STORAGE_KEY,
      NETWORK_PARAMETERS_RPC_TIMEOUT_MS,
    ),
  ]);

  const taoWeight = taoWeightBits != null ? u64f64ToFloat(taoWeightBits) : null;
  const stakeThresholdTao =
    stakeThresholdRao != null ? raoToTao(stakeThresholdRao) : null;
  const pendingChildKeyCooldownBlocks =
    pendingChildKeyCooldownBits != null
      ? Number(pendingChildKeyCooldownBits)
      : null;
  // Derived here rather than served from storage: the `BlockEmission` item
  // reads 1.0 TAO and has been stale since the first halving, so every share
  // computed against it is wrong by 2x (#8747).
  const emission = blockEmissionForIssuance(totalIssuanceRao);
  const rpcOk =
    taoWeight != null &&
    stakeThresholdTao != null &&
    pendingChildKeyCooldownBlocks != null &&
    emission != null;

  const payload: NetworkParameters = {
    schema_version: 1,
    tao_weight: taoWeight,
    stake_threshold_tao: stakeThresholdTao,
    pending_childkey_cooldown_blocks: pendingChildKeyCooldownBlocks,
    total_issuance_tao:
      totalIssuanceRao != null ? raoToTao(totalIssuanceRao) : null,
    block_emission_tao: emission?.tao_per_block ?? null,
    block_emission_halvings: emission?.halvings ?? null,
    queried_at: queriedAt,
  };

  if (kv?.put) {
    try {
      await kv.put(cacheKey, JSON.stringify(payload), {
        expirationTtl: rpcOk
          ? NETWORK_PARAMETERS_KV_TTL
          : NETWORK_PARAMETERS_NEGATIVE_KV_TTL,
      });
    } catch {
      // KV write failure is non-fatal.
    }
  }

  return payload;
}
