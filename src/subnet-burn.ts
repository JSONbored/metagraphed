// Live current registration (recycle/burn) cost for one subnet (#6321), via
// RPC. Shared by GET /api/v1/subnets/{netuid}/burn.
//
// min_burn_tao/max_burn_tao (src/subnet-hyperparams.ts, from the
// subnet_hyperparams D1/Postgres tier) are the static floor/ceiling — the
// actual current price sits anywhere between the two, moving with recent
// registration activity (an auction-like mechanism), and isn't derivable
// from the bounds alone. SubtensorModule::Burn is the chain's own live
// current value, confirmed live 2026-07-17 to match exactly what the
// Bittensor SDK's own `Subtensor.recycle(netuid)` helper returns
// (`get_hyperparameter(param_name="Burn", netuid=netuid)`, then
// `Balance.from_rao`) — same u64-rao StorageMap<NetUid, u64> shape as
// SubtensorModule::RAORecycledForRegistration (src/subnet-recycled.ts),
// so this mirrors that file's live-RPC + KV-cache approach rather than
// adding a new capture pipeline. Cached for a much shorter TTL than
// recycled_tao's 600s: registration bursts can move this within minutes.
//
// Storage key = twox128("SubtensorModule") ++ twox128("Burn") ++ <netuid as
// u16, little-endian, Identity hasher — no hash on the map key itself>. The
// twox128 prefix pair is fixed (hardcoded below, matching subnet-
// recycled.mjs's/sudo-key.ts's own precedent) since twox128 needs XXHash64,
// not in Node's built-in crypto and not worth implementing for two constant
// strings; only the trailing 2-byte netuid suffix is computed per request.
// Verified live against finney (bittensor 10.5.0,
// substrate.create_storage_key("SubtensorModule", "Burn", [netuid])) and via
// a raw state_getStorage RPC call for netuid 1 (result 0x20a1070000000000 =
// 500000 rao, matching Subtensor.recycle(1) exactly).

import { isU16Netuid } from "./subnet-recycled.ts";

export const BURN_KV_TTL = 120; // seconds — moves within minutes during registration bursts
export const BURN_NEGATIVE_KV_TTL = 10; // seconds
export const BURN_RPC_TIMEOUT_MS = 5000;
const FINNEY_RPC_URL = "https://entrypoint-finney.opentensor.ai:443";

// twox128("SubtensorModule") ++ twox128("Burn").
const BURN_STORAGE_KEY_PREFIX =
  "0x658faa385070e074c85bf6b568cf055501be1755d08418802946bca51b686325";

// netuid (0..65535) as a u16, little-endian, 2 hex bytes — the Identity-hashed
// map-key suffix appended to the fixed prefix above. Same shape as subnet-
// recycled.mjs's own helper, duplicated rather than imported (self-contained
// file convention this codebase already uses for account-balance.mjs/
// sudo-key.ts's own decode helpers).
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
// precision loss (mirrors subnet-recycled.ts's identical conversion).
function raoToTao(rao: bigint): number {
  return Number(rao / 1_000_000_000n) + Number(rao % 1_000_000_000n) / 1e9;
}

type Row = Record<string, unknown>;

// Query the live current burn/registration cost for one subnet. Uses
// METAGRAPH_CONTROL KV (120s TTL, same binding as loadSubnetRecycled/
// loadSudoKey) when present; burn_tao is null on RPC failure or a malformed
// result (schema-stable, never throws). A subnet with a genuinely zero burn
// cost reads back the chain's own 0x00...0 ValueQuery default, decoding to a
// real 0, not null.
export async function loadSubnetBurn(env: Env, netuid: number): Promise<Row> {
  if (!isU16Netuid(netuid)) {
    throw new RangeError("netuid must be an integer in the u16 range 0..65535");
  }

  const cacheKey = `burn:${netuid}`;
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
  let burnTao: number | null = null;
  let rpcOk = false;

  try {
    const storageKey = BURN_STORAGE_KEY_PREFIX + netuidStorageKeySuffix(netuid);
    const rpcResp = await fetch(FINNEY_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(BURN_RPC_TIMEOUT_MS),
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
        burnTao = raoToTao(rao);
        rpcOk = true;
      } else if (raw === null) {
        // Genuinely unset storage reads as a real zero, not a failure —
        // mirrors loadSubnetRecycled's / loadSudoKey's unset-storage case.
        burnTao = 0;
        rpcOk = true;
      }
    }
  } catch {
    // RPC fetch failed — burn_tao stays null.
  }

  const payload: Row = {
    schema_version: 1,
    netuid,
    burn_tao: burnTao,
    queried_at: queriedAt,
  };

  if (kv?.put) {
    try {
      await kv.put(cacheKey, JSON.stringify(payload), {
        expirationTtl: rpcOk ? BURN_KV_TTL : BURN_NEGATIVE_KV_TTL,
      });
    } catch {
      // KV write failure is non-fatal.
    }
  }

  return payload;
}
