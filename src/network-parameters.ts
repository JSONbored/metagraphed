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
// TaoWeight raw result 0x7a14ae47e17a142e -> a U64F64 fixed-point ratio
// (bits/2**64 = 0.18004..., matching live TaoWeight ~0.18 at the time
// the underlying issue was filed -- this is governance-adjustable and
// will drift, the fixed-point DECODING is what's verified, not the
// specific value).
// StakeThreshold raw result 0x0010a5d4e8000000 -> a plain u64 rao amount
// (1e12 rao = 1000 TAO exactly).
// PendingChildKeyCooldown raw result 0x201c000000000000 -> a plain u64
// block count (7200, no TAO conversion).

import { blockEmissionForIssuance } from "./block-emission.ts";
import type { FieldSources } from "./field-provenance.ts";
import {
  type ChainNetworkId,
  networkKvKey,
  rpcUrlForNetwork,
} from "./chain-network.ts";

export const NETWORK_PARAMETERS_KV_TTL = 300; // seconds -- governance-adjustable, changes rarely but not never
export const NETWORK_PARAMETERS_NEGATIVE_KV_TTL = 10; // seconds
export const NETWORK_PARAMETERS_RPC_TIMEOUT_MS = 5000;

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
// #8742: the three spec-440 emission-gate parameters. All U64F64 StorageValues
// under the same SubtensorModule prefix -- and all SIXTEEN bytes, not eight,
// which is why they cannot go through fetchStorageU64 below.
// twox128("SubtensorModule") ++ twox128("EmissionGateBar").
export const EMISSION_GATE_BAR_STORAGE_KEY =
  "0x658faa385070e074c85bf6b568cf05557c9b0d2964cc73e7519676c3cc4d5df9";
// twox128("SubtensorModule") ++ twox128("EmissionBarQuantile").
export const EMISSION_BAR_QUANTILE_STORAGE_KEY =
  "0x658faa385070e074c85bf6b568cf0555a772007dde2ed63e0f21b5f9d7f16650";
// twox128("SubtensorModule") ++ twox128("EmissionGateExponent").
export const EMISSION_GATE_EXPONENT_STORAGE_KEY =
  "0x658faa385070e074c85bf6b568cf055588c70e8dd0cf4af3aeb977ba2eee1df4";

/**
 * `DefaultEmissionGateExponent` from the v440 runtime (lib.rs).
 *
 * The storage item is UNSET on chain, and absent means "use this", NOT zero.
 * h = 0 makes the Hill gate 1/(1+(theta/w)^0) = 0.5 for every subnet -- a
 * silently plausible wrong answer that would misreport the gate for all 128 of
 * them at once. That is why the raw and effective values are served as separate
 * fields below rather than collapsed into one.
 */
export const DEFAULT_EMISSION_GATE_EXPONENT = 3;

/**
 * `DefaultPendingChildKeyCooldown` — 7200 blocks (one day at 12s).
 *
 * Read straight out of the runtime metadata's declared fallback for
 * `SubtensorModule.PendingChildKeyCooldown` (`0x201c000000000000`, LE u64), and
 * identical on finney and testnet as of spec 441.
 *
 * It is SET on finney and ABSENT on testnet, which is why this had to become
 * explicit for #8700: the previous implicit zero would have told a testnet
 * developer their child-key changes take effect immediately.
 */
export const DEFAULT_PENDING_CHILDKEY_COOLDOWN_BLOCKS = 7200n;

/**
 * `DefaultEmissionBarQuantile` — 0.61, as U64F64 bits.
 *
 * Same provenance as the cooldown above (metadata fallback
 * `0x00285c8fc2f5289c…`), same finney-set / testnet-absent split. Serving the
 * declared default rather than `null` also keeps the whole response off the
 * 10s negative TTL: `rpcOk` below requires every field to be non-null, so an
 * unset quantile would have pinned testnet to negative caching forever and
 * re-hit the RPC on every single request.
 */
export const DEFAULT_EMISSION_BAR_QUANTILE_BITS = 0x9c28f5c28f5c2800n;

export const TOTAL_ISSUANCE_STORAGE_KEY =
  "0x658faa385070e074c85bf6b568cf055557c875e4cff74148e4628f264b974c80";

// Decode a "0x"-prefixed, 16-hex-char (8-byte) little-endian u64 into a
// BigInt. Returns null for anything else (malformed/short/absent result).
export function decodeLeU64(hex: unknown): bigint | null {
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
// (non-ok response, timeout, malformed result).
//
// An absent key is NOT a failure and NOT necessarily a zero. Every item read
// here is declared `modifier: Default` in the runtime metadata, which means the
// chain's own accessor returns the item's declared default when nothing is
// stored -- so the true on-chain value of an absent key is that default, and
// `whenUnset` is how each call site states it.
//
// This defaulted to 0n implicitly before #8700, which was invisible on finney
// because every item here happens to be set there. It is not set on testnet:
// `PendingChildKeyCooldown` is absent, and reading it as 0 would publish "no
// cooldown" for a chain whose real cooldown is 7200 blocks -- a silently
// plausible wrong answer, the same trap #8742 documented for the emission gate
// exponent.
async function fetchStorageU64(
  storageKey: string,
  timeoutMs: number,
  network?: ChainNetworkId,
  whenUnset: bigint = 0n,
): Promise<bigint | null> {
  try {
    const rpcResp = await fetch(rpcUrlForNetwork(network), {
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
    if (raw === null) return whenUnset;
    return null;
  } catch {
    return null;
  }
}

/**
 * Decode a "0x"-prefixed 32-hex-char (16-byte) little-endian u128.
 *
 * Separate from decodeLeU64 rather than a widening of it: that function
 * REJECTS anything but 16 hex chars, and silently returning null for a
 * perfectly good 16-byte value is exactly how these three parameters would
 * have read as "unavailable" forever.
 */
export function decodeLeU128(hex: unknown): bigint | null {
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]{32}$/.test(hex)) {
    return null;
  }
  let value = 0n;
  for (let i = hex.length - 2; i >= 2; i -= 2) {
    value = (value << 8n) | BigInt(parseInt(hex.slice(i, i + 2), 16));
  }
  return value;
}

/** U64F64 (64 integer bits + 64 fraction bits) as a float. */
export function u64f64U128ToFloat(bits: bigint): number {
  // Split in BigInt space before dividing -- Number(bits) / 2**64 routes the
  // numerator through double rounding first. Same reasoning as
  // src/subnet-conviction.ts's u64f64BitsToFloat.
  const scale = 1n << 64n;
  return Number(bits / scale) + Number(bits % scale) / Number(scale);
}

/**
 * U96F32 (96 integer bits + 32 fraction bits) as a float.
 *
 * A DIFFERENT SCALE from its U64F64 sibling above, and the difference is not
 * cosmetic: `MinerBurned` is U96F32, and reading it as rao lands ~4e9 out --
 * the single largest error in the first v440 reconstruction (#8739), which it
 * moved from a 4.3e-8 mean share error to 5.4e-4. Two fixed-point widths in
 * one pallet is a trap, so they get two clearly named functions rather than
 * one with a scale argument somebody can pass wrongly.
 */
export function u96f32U128ToFloat(bits: bigint): number {
  // Split in BigInt space before dividing, same reasoning as u64f64 above.
  const scale = 1n << 32n;
  return Number(bits / scale) + Number(bits % scale) / Number(scale);
}

/**
 * A u128 storage read that distinguishes UNSET from FAILED.
 *
 * fetchStorageU64 folds both into "0n or null", which is fine where absent
 * genuinely means zero. It is not fine for EmissionGateExponent, where absent
 * means "use the runtime default" and zero means something else entirely.
 */
type StorageU128Result =
  { state: "value"; bits: bigint } | { state: "unset" } | { state: "failed" };

async function fetchStorageU128(
  storageKey: string,
  timeoutMs: number,
  network?: ChainNetworkId,
): Promise<StorageU128Result> {
  try {
    const rpcResp = await fetch(rpcUrlForNetwork(network), {
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
    if (!rpcResp.ok) return { state: "failed" };
    const rpcBody = (await rpcResp.json()) as Record<string, unknown>;
    const raw = rpcBody?.result;
    if (raw === null) return { state: "unset" };
    const bits = decodeLeU128(raw);
    return bits != null ? { state: "value", bits } : { state: "failed" };
  } catch {
    return { state: "failed" };
  }
}

/**
 * Where each published value came from (#9078).
 *
 * Three reconstructions here, and they are the reason this route needed a map
 * more than any other:
 *
 * - `block_emission_tao` / `block_emission_halvings` are derived from
 * `TotalIssuance`, NEVER read from the `BlockEmission` storage item, which
 * has been stale at 1.0 TAO since the first halving (#8747). The item exists
 * and would look like the obvious source; publishing `storage: null` says
 * plainly that we did not use it.
 * - `emission_gate_exponent_effective` is `DEFAULT_EMISSION_GATE_EXPONENT`
 * whenever the storage item is unset, which is its current state on finney.
 * Without this map a caller sees `3` and has no way to learn it came from our
 * source tree rather than the chain — the `null` beside it in
 * `emission_gate_exponent` reads as missing data, not as the tell. It stays
 * reconstructed even when the item IS set and the two agree: which one it is
 * depends on chain state the caller cannot see, and a field whose kind flips
 * per response is not a contract.
 *
 * Everything else is one read, decoded. `stake_threshold_tao` divided by 1e9
 * and `tao_weight` decoded from U64F64 are still that single read.
 */
export const NETWORK_PARAMETERS_FIELD_SOURCES = {
  tao_weight: { kind: "measured", storage: "SubtensorModule.TaoWeight" },
  stake_threshold_tao: {
    kind: "measured",
    storage: "SubtensorModule.StakeThreshold",
  },
  pending_childkey_cooldown_blocks: {
    kind: "measured",
    storage: "SubtensorModule.PendingChildKeyCooldown",
  },
  total_issuance_tao: {
    kind: "measured",
    storage: "SubtensorModule.TotalIssuance",
  },
  block_emission_tao: { kind: "reconstructed", storage: null },
  block_emission_halvings: { kind: "reconstructed", storage: null },
  emission_gate_bar: {
    kind: "measured",
    storage: "SubtensorModule.EmissionGateBar",
  },
  emission_bar_quantile: {
    kind: "measured",
    storage: "SubtensorModule.EmissionBarQuantile",
  },
  emission_gate_exponent: {
    kind: "measured",
    storage: "SubtensorModule.EmissionGateExponent",
  },
  emission_gate_exponent_effective: { kind: "reconstructed", storage: null },
} as const satisfies FieldSources;

/**
 * The cacheable body: what the RPC reads produce, and exactly what goes into
 * KV. `field_sources` is deliberately NOT part of it — see
 * {@link loadNetworkParameters}.
 */
export interface NetworkParametersSnapshot {
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
  /** Spec-440 emission gate: the q-mass bar (theta), recomputed every 360 blocks. */
  emission_gate_bar: number | null;
  /** Spec-440 emission gate: the quantile (q) the bar is taken at. */
  emission_bar_quantile: number | null;
  /**
   * The exponent (h) AS STORED — null when the storage item is unset, which is
   * its current state. Not the value the gate uses; see the effective field.
   */
  emission_gate_exponent: number | null;
  /** The exponent the gate actually applies: the stored value, or the runtime default. */
  emission_gate_exponent_effective: number | null;
  queried_at: string;
}

export interface NetworkParameters extends NetworkParametersSnapshot {
  field_sources: typeof NETWORK_PARAMETERS_FIELD_SOURCES;
}

/**
 * The cached snapshot ONLY — never a live RPC read.
 *
 * `/freshness` reports how current the live-RPC lane is, and it must not become a
 * reason for that lane to be queried: a freshness probe that triggers the work it is
 * measuring would refresh `queried_at` on every call and always report "current",
 * which is precisely a lane that cannot go stale and therefore cannot be gated on.
 *
 * Null when KV is unbound or cold — the caller reports `missing`, not an age.
 */
export async function readCachedNetworkParametersSnapshot(
  env: Env,
  network?: ChainNetworkId,
): Promise<NetworkParametersSnapshot | null> {
  const kv = env?.METAGRAPH_CONTROL;
  if (!kv?.get) return null;
  try {
    return (
      (await kv.get<NetworkParametersSnapshot>(
        networkKvKey("network:parameters", network),
        { type: "json" },
      )) ?? null
    );
  } catch {
    return null;
  }
}

// Query the live global governance parameters. Uses METAGRAPH_CONTROL KV
// (300s TTL) when present; each field is independently null on its own RPC
// failure (schema-stable, never throws) -- three parallel reads against the
// same endpoint, not a single combined query (no batched-storage RPC method
// this codebase already relies on elsewhere). Positive-caches only when all
// three succeed, so a partial failure doesn't cache a stale-looking result
// for the full TTL.
async function loadNetworkParametersSnapshot(
  env: Env,
  network?: ChainNetworkId,
): Promise<NetworkParametersSnapshot> {
  // Governance parameters are set independently per chain, so testnet must not
  // read finney's cached snapshot (or write over it).
  const cacheKey = networkKvKey("network:parameters", network);
  const kv = env?.METAGRAPH_CONTROL;

  if (kv?.get) {
    try {
      const cached = await kv.get<NetworkParametersSnapshot>(cacheKey, {
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
    emissionGateBarResult,
    emissionBarQuantileResult,
    emissionGateExponentResult,
  ] = await Promise.all([
    // TaoWeight, StakeThreshold and TotalIssuance all declare a 0 default, so
    // they keep fetchStorageU64's implicit whenUnset. Only the cooldown does
    // not -- passing its default explicitly is the whole point of #8700's
    // unset-storage fix.
    fetchStorageU64(
      TAO_WEIGHT_STORAGE_KEY,
      NETWORK_PARAMETERS_RPC_TIMEOUT_MS,
      network,
    ),
    fetchStorageU64(
      STAKE_THRESHOLD_STORAGE_KEY,
      NETWORK_PARAMETERS_RPC_TIMEOUT_MS,
      network,
    ),
    fetchStorageU64(
      PENDING_CHILDKEY_COOLDOWN_STORAGE_KEY,
      NETWORK_PARAMETERS_RPC_TIMEOUT_MS,
      network,
      DEFAULT_PENDING_CHILDKEY_COOLDOWN_BLOCKS,
    ),
    fetchStorageU64(
      TOTAL_ISSUANCE_STORAGE_KEY,
      NETWORK_PARAMETERS_RPC_TIMEOUT_MS,
      network,
    ),
    fetchStorageU128(
      EMISSION_GATE_BAR_STORAGE_KEY,
      NETWORK_PARAMETERS_RPC_TIMEOUT_MS,
      network,
    ),
    fetchStorageU128(
      EMISSION_BAR_QUANTILE_STORAGE_KEY,
      NETWORK_PARAMETERS_RPC_TIMEOUT_MS,
      network,
    ),
    fetchStorageU128(
      EMISSION_GATE_EXPONENT_STORAGE_KEY,
      NETWORK_PARAMETERS_RPC_TIMEOUT_MS,
      network,
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

  // Declared default is a literal zero (`0x00…00`), so an unset read resolves
  // to 0 for the same reason the quantile resolves to 0.61: `modifier: Default`
  // means the chain hands back the fallback. Distinct from `failed`, which
  // stays null — "the gate is off" and "we could not read the gate" are not the
  // same answer, and collapsing them is what the state machine exists to avoid.
  const emissionGateBar =
    emissionGateBarResult.state === "value"
      ? u64f64U128ToFloat(emissionGateBarResult.bits)
      : emissionGateBarResult.state === "unset"
        ? 0
        : null;
  // Unset resolves to the runtime's declared default (0.61), not to null: the
  // item is `modifier: Default`, so an absent key means the chain is USING that
  // default, not that the value is unknown. finney has it set and is unaffected;
  // testnet has it absent, where null would both under-report the gate and --
  // because rpcOk below requires every field -- pin the whole response to the
  // 10s negative TTL on every request.
  const emissionBarQuantile =
    emissionBarQuantileResult.state === "value"
      ? u64f64U128ToFloat(emissionBarQuantileResult.bits)
      : emissionBarQuantileResult.state === "unset"
        ? u64f64U128ToFloat(DEFAULT_EMISSION_BAR_QUANTILE_BITS)
        : null;
  // Raw stays null when the item is unset -- that is the honest reading, and
  // the effective value carries the runtime default alongside it rather than
  // in place of it (#8742 trap 2).
  const emissionGateExponent =
    emissionGateExponentResult.state === "value"
      ? u64f64U128ToFloat(emissionGateExponentResult.bits)
      : null;
  const emissionGateExponentEffective =
    emissionGateExponentResult.state === "value"
      ? emissionGateExponent
      : emissionGateExponentResult.state === "unset"
        ? DEFAULT_EMISSION_GATE_EXPONENT
        : null;
  const rpcOk =
    taoWeight != null &&
    stakeThresholdTao != null &&
    pendingChildKeyCooldownBlocks != null &&
    emission != null &&
    emissionGateBar != null &&
    emissionBarQuantile != null &&
    // "unset" is a successful read, not a failure -- caching it for the full
    // TTL is correct, and treating it as a partial failure would put this
    // whole response on the 10s negative TTL indefinitely.
    emissionGateExponentResult.state !== "failed";

  const payload: NetworkParametersSnapshot = {
    schema_version: 1,
    tao_weight: taoWeight,
    stake_threshold_tao: stakeThresholdTao,
    pending_childkey_cooldown_blocks: pendingChildKeyCooldownBlocks,
    total_issuance_tao:
      totalIssuanceRao != null ? raoToTao(totalIssuanceRao) : null,
    block_emission_tao: emission?.tao_per_block ?? null,
    block_emission_halvings: emission?.halvings ?? null,
    emission_gate_bar: emissionGateBar,
    emission_bar_quantile: emissionBarQuantile,
    emission_gate_exponent: emissionGateExponent,
    emission_gate_exponent_effective: emissionGateExponentEffective,
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

/**
 * The served governance parameters: the snapshot above plus its provenance map.
 *
 * Attached here, outside the loader, so the map never enters the KV blob — a
 * correction to it takes effect on the next read rather than after the 300s
 * TTL, and entries cached before #9078 don't come back without one. It is also
 * the single point REST, GraphQL, and MCP all inherit provenance from, instead
 * of three call sites kept in step by hand (src/emission-pipeline-surface.ts's
 * header is about that exact failure mode).
 */
export async function loadNetworkParameters(
  env: Env,
  network?: ChainNetworkId,
): Promise<NetworkParameters> {
  return {
    ...(await loadNetworkParametersSnapshot(env, network)),
    field_sources: NETWORK_PARAMETERS_FIELD_SOURCES,
  };
}
