// Live cumulative TAO recycled for registration on one subnet (#4339/8.4),
// via RPC. Shared by GET /api/v1/subnets/{netuid}/recycled.
//
// Finding (2026-07-09, empirically verified against live finney): the issue's
// premise — "derivable from burn-on-registration extrinsics already in the
// log layer" — does not hold. A burned_register extrinsic's call_args carries
// only (netuid, hotkey), never an amount; its own fee_tao is the ordinary
// per-byte transaction fee (~0.002 TAO), unrelated to the burn; and no
// Balances-pallet event (the on-chain burn actually posts as a plain
// Balances::Withdraw, confirmed via substrate.get_events at a live
// burned_register block) is ingested by this codebase's account_events
// pipeline at all. subnet_hyperparams_history (#4309) captures only
// min_burn_tao/max_burn_tao — the dynamic bounds — never the live current
// burn cost. So there is no log-layer path to this figure without a new
// capture pipeline, which the issue explicitly rules out.
//
// What IS available, and simpler: SubtensorModule::RAORecycledForRegistration
// is a plain on-chain StorageMap<NetUid, u64> — the chain's OWN running total
// of rao recycled for registration on that subnet, confirmed live to match
// exactly the `amount` attribute the same block's SubtensorModule::
// RAORecycledForRegistrationSet event carries. A single state_getStorage
// query returns it directly — the same live-RPC + KV-cache shape this
// codebase already uses for /accounts/{ss58}/balance and /sudo/key
// (src/account-balance.ts, src/sudo-key.ts), not a new capture pipeline.
//
// Storage key = twox128("SubtensorModule") ++ twox128(
// "RAORecycledForRegistration") ++ <netuid as u16, little-endian, Identity
// hasher — no hash on the map key itself>. The twox128 prefix pair is fixed
// (hardcoded below, like sudo-key.ts hardcodes its own fixed key) since
// twox128 needs XXHash64, which isn't in Node's built-in crypto and isn't
// worth implementing for two constant strings; only the trailing 2-byte
// netuid suffix is computed per request. Verified live against finney
// (bittensor 10.4.0, substrate.create_storage_key("SubtensorModule",
// "RAORecycledForRegistration", [netuid])) across netuid 0/1/4/101/65535.

import type { FieldSources } from "./field-provenance.ts";
import {
  type ChainNetworkId,
  networkKvKey,
  rpcUrlForNetwork,
} from "./chain-network.ts";

type Row = Record<string, unknown>;

export const RECYCLED_KV_TTL = 600; // seconds — a registration-count counter, not a live price
export const RECYCLED_NEGATIVE_KV_TTL = 10; // seconds
export const RECYCLED_RPC_TIMEOUT_MS = 5000;
export const MAX_U16_NETUID = 65535;

// twox128("SubtensorModule") ++ twox128("RAORecycledForRegistration").
const RECYCLED_STORAGE_KEY_PREFIX =
  "0x658faa385070e074c85bf6b568cf05550675ef84d5b014be06eda8faa54a78fb";

// netuid (0..65535) as a u16, little-endian, 2 hex bytes — the Identity-hashed
// map-key suffix appended to the fixed prefix above.
export function isU16Netuid(netuid: unknown): netuid is number {
  return (
    typeof netuid === "number" &&
    Number.isInteger(netuid) &&
    netuid >= 0 &&
    netuid <= MAX_U16_NETUID
  );
}

// Callers (loadSubnetRecycled) validate netuid via isU16Netuid before
// reaching here, so no redundant guard.
function netuidStorageKeySuffix(netuid: number): string {
  const lo = (netuid % 256).toString(16).padStart(2, "0");
  const hi = Math.floor(netuid / 256)
    .toString(16)
    .padStart(2, "0");
  return lo + hi;
}

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
// precision loss on large cumulative totals (mirrors account-balance.ts's
// same-shaped conversion).
function raoToTao(rao: bigint): number {
  return Number(rao / 1_000_000_000n) + Number(rao % 1_000_000_000n) / 1e9;
}

// Query the live cumulative TAO recycled for registration on one subnet. Uses
// METAGRAPH_CONTROL KV (600s TTL, same binding as loadAccountBalance/
// loadSudoKey) when present; recycled_tao is null on RPC failure or a
// malformed result (schema-stable, never throws). A subnet with zero
// registrations reads back the chain's own 0x00...0 ValueQuery default,
// decoding to a real 0, not null.
/**
 * Where each published value came from (#9104).
 *
 * `measured`, and naming the item is the point: this is the chain's own
 * cumulative counter, deliberately NOT an account_events aggregation -- the
 * burn amount is captured by no ingested event or extrinsic field, so
 * reconstructing it from the log layer is not possible. The map says which of
 * those two things the number is, in band.
 */
export const SUBNET_RECYCLED_FIELD_SOURCES = {
  recycled_tao: {
    kind: "measured",
    storage: "SubtensorModule.RAORecycledForRegistration",
  },
} as const satisfies FieldSources;

async function loadSubnetRecycledSnapshot(
  env: Env,
  netuid: number,
  network?: ChainNetworkId,
): Promise<Row> {
  if (!isU16Netuid(netuid)) {
    throw new RangeError("netuid must be an integer in the u16 range 0..65535");
  }

  // Per-chain counter: testnet netuids do not correspond to mainnet ones, so
  // the two must never share a cache entry.
  const cacheKey = networkKvKey(`recycled:${netuid}`, network);
  const kv = env?.METAGRAPH_CONTROL;

  if (kv?.get) {
    try {
      const cached = await kv.get(cacheKey, { type: "json" });
      if (cached) return cached as Row;
    } catch {
      // KV read failure is non-fatal — fall through to the live RPC.
    }
  }

  const queriedAt = new Date().toISOString();
  let recycledTao: number | null = null;
  let rpcOk = false;

  try {
    const storageKey =
      RECYCLED_STORAGE_KEY_PREFIX + netuidStorageKeySuffix(netuid);
    const rpcResp = await fetch(rpcUrlForNetwork(network), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(RECYCLED_RPC_TIMEOUT_MS),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "state_getStorage",
        params: [storageKey],
      }),
    });
    if (rpcResp.ok) {
      const rpcBody = (await rpcResp.json()) as Row;
      const raw = rpcBody?.result;
      const rao = decodeLeU64(raw);
      if (rao != null) {
        recycledTao = raoToTao(rao);
        rpcOk = true;
      } else if (raw === null) {
        // Genuinely unset storage (pre-ValueQuery-default chain state, or an
        // RPC that returns null rather than the zeroed default) reads as a
        // real zero, not a failure — mirrors loadSudoKey's unset-storage case.
        recycledTao = 0;
        rpcOk = true;
      }
    }
  } catch {
    // RPC fetch failed — recycled_tao stays null.
  }

  const payload: Row = {
    schema_version: 1,
    netuid,
    recycled_tao: recycledTao,
    queried_at: queriedAt,
  };

  if (kv?.put) {
    try {
      await kv.put(cacheKey, JSON.stringify(payload), {
        expirationTtl: rpcOk ? RECYCLED_KV_TTL : RECYCLED_NEGATIVE_KV_TTL,
      });
    } catch {
      // KV write failure is non-fatal.
    }
  }

  return payload;
}

/**
 * The served scorecard: the snapshot above plus its provenance map.
 *
 * Attached outside the loader so it never enters the KV blob -- at a 600s TTL
 * an entry cached before #9104 would otherwise serve without provenance for the
 * rest of its life. It is also the single point REST, GraphQL and MCP all
 * inherit it from, rather than three call sites kept in step by hand.
 */
export async function loadSubnetRecycled(
  env: Env,
  netuid: number,
  network?: ChainNetworkId,
): Promise<Row> {
  return {
    ...(await loadSubnetRecycledSnapshot(env, netuid, network)),
    field_sources: SUBNET_RECYCLED_FIELD_SOURCES,
  };
}
