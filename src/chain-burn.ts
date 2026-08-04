// Every subnet's live registration (recycle/burn) cost, in ONE chain read (#9399).
//
// The per-subnet sibling (src/subnet-burn.ts) answers "what does netuid N cost". The
// question an operator actually asks first is "where is registration cheapest right
// now", and answering it through that route means 129 requests. The spread is not
// marginal either -- measured 2026-08-04, netuids 16/18/52/104/117/122 sat at 1.0 TAO
// while netuid 92 was 0.0001 and netuid 76 was 0.0, a 10,000x range.
//
// ONE CALL, NOT 129. `SubtensorModule.Burn` is an Identity-hashed map, so the storage
// key for a netuid is the fixed twox128 prefix pair followed by the netuid as a
// little-endian u16 -- no hashing of the key itself, which means every key is
// DERIVABLE without enumerating the map. `state_queryStorageAt` takes the whole list
// and returns them together: measured 129 subnets in 0.64s against the public archive.
//
// `state_getKeys`/`state_getPairs` would be the obvious way to enumerate a map, and
// both are refused by the public endpoint ("RPC call is unsafe to be called
// externally", code 4003). Deriving the keys sidesteps that entirely.
//
// A NOTE ON THE HASHER, because getting it wrong is silent: these SubtensorModule
// netuid maps use Identity. A twox_64_concat key -- the usual default, and what the
// sibling account maps use -- returns null for every netuid, which reads exactly like
// "this value is unset chain-wide" rather than like a bug. The control that catches it
// is reading a value you already know by another route: Tempo[64] must be 360.

import {
  type ChainNetworkId,
  networkKvKey,
  rpcUrlForNetwork,
} from "./chain-network.ts";
import type { FieldSources } from "./field-provenance.ts";

type Row = Record<string, unknown>;

/** Seconds. Matches the per-subnet route: burn moves within minutes during a
 * registration burst, so a long TTL would serve a stale price for a decision that
 * costs TAO. */
export const CHAIN_BURN_KV_TTL = 120;
/** A failed read is re-tried soon rather than cached as an answer. */
export const CHAIN_BURN_NEGATIVE_KV_TTL = 10;
/** Larger than the single-subnet timeout: this is one call carrying ~129 keys. */
export const CHAIN_BURN_RPC_TIMEOUT_MS = 12_000;

/**
 * Hard ceiling on how many netuids are probed.
 *
 * The netuid range is read from `SubtensorModule.TotalNetworks` (129 on mainnet at time
 * of writing) rather than hardcoded, so a new subnet appears here the moment it exists.
 * This cap only bounds a chain that reports something absurd -- it is not the expected
 * count, and it must stay well above `SubnetLimit` (128) or a legitimately grown
 * network would be silently truncated.
 */
export const CHAIN_BURN_MAX_NETUIDS = 1024;

// twox128("SubtensorModule") ++ twox128("Burn"). Same fixed prefix the per-subnet
// route uses; twox128 needs XXHash64, which Node's crypto does not carry and which is
// not worth implementing for two constant strings.
const BURN_STORAGE_KEY_PREFIX =
  "0x658faa385070e074c85bf6b568cf055501be1755d08418802946bca51b686325";

// twox128("SubtensorModule") ++ twox128("TotalNetworks").
const TOTAL_NETWORKS_STORAGE_KEY =
  "0x658faa385070e074c85bf6b568cf05555f3bb7bcd0a076a48abf8c256d221721";

/** netuid as a little-endian u16, 2 hex bytes — the Identity map-key suffix. */
function netuidStorageKeySuffix(netuid: number): string {
  const lo = (netuid % 256).toString(16).padStart(2, "0");
  const hi = Math.floor(netuid / 256)
    .toString(16)
    .padStart(2, "0");
  return lo + hi;
}

/** The netuid a Burn storage key refers to, or null when the key is not one of ours. */
export function netuidFromBurnKey(key: unknown): number | null {
  if (typeof key !== "string") return null;
  if (!key.startsWith(BURN_STORAGE_KEY_PREFIX)) return null;
  const suffix = key.slice(BURN_STORAGE_KEY_PREFIX.length);
  if (!/^[0-9a-fA-F]{4}$/.test(suffix)) return null;
  const lo = parseInt(suffix.slice(0, 2), 16);
  const hi = parseInt(suffix.slice(2, 4), 16);
  return hi * 256 + lo;
}

/** A "0x"-prefixed little-endian u64 as a BigInt, or null when malformed/absent. */
function decodeLeU64(hex: unknown): bigint | null {
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]{16}$/.test(hex)) return null;
  let value = 0n;
  for (let i = hex.length - 2; i >= 2; i -= 2) {
    value = (value << 8n) | BigInt(parseInt(hex.slice(i, i + 2), 16));
  }
  return value;
}

/** A "0x"-prefixed little-endian u16 as a number, or null when malformed/absent. */
function decodeLeU16(hex: unknown): number | null {
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]{4}$/.test(hex)) return null;
  return parseInt(hex.slice(4, 6), 16) * 256 + parseInt(hex.slice(2, 4), 16);
}

/** BigInt rao -> Number TAO, divided in BigInt space first to avoid float loss. */
function raoToTao(rao: bigint): number {
  return Number(rao / 1_000_000_000n) + Number(rao % 1_000_000_000n) / 1e9;
}

export const CHAIN_BURN_FIELD_SOURCES = {
  burn_tao: { kind: "measured", storage: "SubtensorModule.Burn" },
  subnet_count: { kind: "measured", storage: "SubtensorModule.TotalNetworks" },
} as const satisfies FieldSources;

async function rpcCall(
  url: string,
  method: string,
  params: unknown[],
): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(CHAIN_BURN_RPC_TIMEOUT_MS),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res?.ok) return null;
  return ((await res.json()) as Row)?.result ?? null;
}

/**
 * Build the ranked card from the `state_queryStorageAt` changes list.
 *
 * A key present with a value is a real subnet, INCLUDING one whose burn is 0 -- netuid
 * 76 reads a genuine zero, and dropping it would hide the cheapest registration on the
 * network. A key absent from the response, or present with a null value, is a netuid
 * that does not exist, and is omitted rather than published as a free subnet.
 */
export function buildChainBurn(
  changes: unknown,
  subnetCount: number | null,
  { queriedAt }: { queriedAt: string },
): Row {
  const rows: Array<{ netuid: number; burn_tao: number }> = [];
  if (Array.isArray(changes)) {
    for (const entry of changes) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      const netuid = netuidFromBurnKey(entry[0]);
      if (netuid === null) continue;
      const rao = decodeLeU64(entry[1]);
      if (rao === null) continue;
      rows.push({ netuid, burn_tao: raoToTao(rao) });
    }
  }
  // Cheapest first: the ranking answers "where should I register", so the useful end
  // leads. Ties break on netuid so the order is stable between reads.
  rows.sort((a, b) => a.burn_tao - b.burn_tao || a.netuid - b.netuid);
  const values = rows.map((r) => r.burn_tao);
  return {
    schema_version: 1,
    queried_at: queriedAt,
    // What the CHAIN says exists, kept separate from how many we could read: a gap
    // between the two is the signal that a read was partial, and collapsing them would
    // hide it.
    subnet_count: subnetCount,
    read_count: rows.length,
    cheapest_burn_tao: values.length ? values[0] : null,
    dearest_burn_tao: values.length ? values[values.length - 1] : null,
    median_burn_tao: values.length
      ? values[Math.floor((values.length - 1) / 2)]
      : null,
    subnets: rows,
  };
}

async function loadChainBurnSnapshot(
  env: Env,
  network?: ChainNetworkId,
): Promise<Row> {
  const cacheKey = networkKvKey("chain-burn", network);
  const kv = env?.METAGRAPH_CONTROL;
  if (kv?.get) {
    try {
      const cached = await kv.get(cacheKey, { type: "json" });
      if (cached) return cached as Row;
    } catch {
      // A KV read failure is non-fatal -- fall through to the live RPC.
    }
  }

  const queriedAt = new Date().toISOString();
  const url = rpcUrlForNetwork(network);
  let payload: Row;
  let rpcOk = false;

  try {
    const total = decodeLeU16(
      await rpcCall(url, "state_getStorage", [TOTAL_NETWORKS_STORAGE_KEY]),
    );
    // Probe one PAST the reported count. TotalNetworks is a count, netuids are
    // 0-indexed, and root (netuid 0) is included -- an off-by-one here would silently
    // drop the newest subnet, which is the one most likely to be cheap and therefore
    // the one an operator is looking for.
    const probe = Math.min((total ?? 0) + 1, CHAIN_BURN_MAX_NETUIDS);
    // No u16 guard here: CHAIN_BURN_MAX_NETUIDS caps `probe` far below 65536, so a
    // per-iteration check would be unreachable. The cap IS the bound -- keeping a
    // second one that can never fire would be a guard nothing can test.
    const keys: string[] = [];
    for (let netuid = 0; netuid < probe; netuid += 1) {
      keys.push(BURN_STORAGE_KEY_PREFIX + netuidStorageKeySuffix(netuid));
    }
    // Always at least one key: `probe` is `(total ?? 0) + 1`, so an unreadable count
    // still probes root. A `keys.length` guard here would be another branch nothing
    // can reach.
    const result = (await rpcCall(url, "state_queryStorageAt", [
      keys,
    ])) as Array<{
      changes?: unknown;
    }> | null;
    const changes = Array.isArray(result) ? result[0]?.changes : null;
    payload = buildChainBurn(changes, total, { queriedAt });
    // Only a read that produced at least one subnet is worth the full TTL; an empty
    // list is indistinguishable from a failed call and must not be cached as an answer.
    rpcOk = (payload.read_count as number) > 0;
  } catch {
    payload = buildChainBurn(null, null, { queriedAt });
  }

  if (kv?.put) {
    try {
      await kv.put(cacheKey, JSON.stringify(payload), {
        expirationTtl: rpcOk ? CHAIN_BURN_KV_TTL : CHAIN_BURN_NEGATIVE_KV_TTL,
      });
    } catch {
      // A KV write failure is non-fatal.
    }
  }
  return payload;
}

/**
 * The served card: the snapshot plus its provenance.
 *
 * Attached outside the loader so it never enters the KV blob -- an entry cached before
 * a provenance change would otherwise serve the old map for the rest of its TTL. It is
 * also the single point REST, MCP and GraphQL inherit it from, rather than three call
 * sites kept in step by hand.
 */
export async function loadChainBurn(
  env: Env,
  network?: ChainNetworkId,
): Promise<Row> {
  return {
    ...(await loadChainBurnSnapshot(env, network)),
    field_sources: CHAIN_BURN_FIELD_SOURCES,
  };
}
