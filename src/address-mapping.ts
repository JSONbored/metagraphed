// Live H160 -> SS58 address mapping via the AddressMapping EVM precompile
// (0x...080c, `addressMapping(address)`, epic #6725/#6728). The precompile's
// own Rust body (opentensor/subtensor precompiles/src/address_mapping.rs)
// just calls `R::AddressMapping::into_account_id(h160)` -- a pure,
// deterministic function of the runtime's configured mapping algorithm, not
// a storage read -- so this queries it live via `eth_call` rather than
// reverse-engineering and replicating that algorithm client-side (the
// sibling issue's own alternative; state_getStorage has no key for a value
// that was never stored). Frontier serves standard Ethereum JSON-RPC methods
// over the SAME endpoint every other live-RPC module here already calls
// (sudo-key.ts/network-parameters.ts/etc resolve it through
// rpcUrlForNetwork() for Substrate-native methods; eth_call is the
// Ethereum-native sibling on that identical endpoint). Mirrors
// src/sudo-key.ts's live-RPC + KV-cache shape.
import { encodeAccountId32 } from "./ss58.ts";
import { functionSelector } from "./evm-precompiles.ts";
import type { FieldSources } from "./field-provenance.ts";
import {
  type ChainNetworkId,
  networkKvKey,
  rpcUrlForNetwork,
} from "./chain-network.ts";

const ADDRESS_MAPPING_PRECOMPILE_ADDRESS =
  "0x000000000000000000000000000000000000080c";
const ADDRESS_MAPPING_SELECTOR = functionSelector("addressMapping(address)");
export const ADDRESS_MAPPING_KV_TTL = 3600; // seconds -- deterministic given h160, never changes
export const ADDRESS_MAPPING_NEGATIVE_KV_TTL = 10; // seconds
export const ADDRESS_MAPPING_RPC_TIMEOUT_MS = 5000;
const FINNEY_SS58_PREFIX = 42;

// Caller shape-checks h160 with this before calling loadAddressMapping,
// same split src/account-balance.ts's isFinneySs58Address/loadAccountBalance
// pair already establishes.
export const H160_PATTERN = /^0x[0-9a-fA-F]{40}$/;

// The one call site already validated a "0x"-prefixed 64-hex-char string via
// regex, so this only ever strips that guaranteed prefix -- not a general
// hex-or-0x-hex parser, same scoping note src/sudo-key.ts's own hexToBytes
// carries.
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.slice(2);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

/**
 * The cacheable body -- exactly what goes into KV. `field_sources` is
 * deliberately not part of it (#9108).
 */
export interface AddressMappingResultSnapshot {
  schema_version: 1;
  h160: string;
  ss58: string | null;
  queried_at: string;
}

// Query the live H160 -> SS58 mapping for one address. Uses METAGRAPH_CONTROL
// KV (1h TTL, same binding as loadSudoKey/loadAccountBalance) when present;
// ss58 is null on RPC failure only -- into_account_id is a total function
// (every H160 maps to SOME AccountId), so unlike loadSudoKey there is no
// legitimate "unset" case to distinguish from failure.
/**
 * Where each published value came from (#9108).
 *
 * Read through the `AddressMapping` EVM precompile (0x...080c), NOT a storage
 * item -- there is no key to read, because the mapping is a pure function of
 * the H160 (`R::AddressMapping::into_account_id`). Naming the precompile is the
 * honest answer: it says the value was computed by the chain's own code rather
 * than looked up, which is a different guarantee from a storage read and a
 * different one again from our arithmetic.
 */
export interface AddressMappingResult extends AddressMappingResultSnapshot {
  field_sources: typeof ADDRESS_MAPPING_FIELD_SOURCES;
}

export const ADDRESS_MAPPING_FIELD_SOURCES = {
  ss58: { kind: "measured", storage: "AddressMapping.addressMapping" },
} as const satisfies FieldSources;

async function loadAddressMappingSnapshot(
  env: Env,
  h160: string,
  network?: ChainNetworkId,
): Promise<AddressMappingResultSnapshot> {
  const normalized = h160.toLowerCase();
  // The precompile is deterministic given h160, but each chain keeps its own
  // mapping table, so the entry is still per-network.
  const cacheKey = networkKvKey(`evm-address-mapping:${normalized}`, network);
  const kv = env?.METAGRAPH_CONTROL;

  if (kv?.get) {
    try {
      const cached = await kv.get(cacheKey, { type: "json" });
      if (cached) return cached as AddressMappingResult;
    } catch {
      // KV read failure is non-fatal -- fall through to the live RPC.
    }
  }

  const queriedAt = new Date().toISOString();
  let ss58: string | null = null;
  let rpcOk = false;

  try {
    const calldata =
      ADDRESS_MAPPING_SELECTOR + normalized.slice(2).padStart(64, "0");
    const rpcResp = await fetch(rpcUrlForNetwork(network), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(ADDRESS_MAPPING_RPC_TIMEOUT_MS),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [
          { to: ADDRESS_MAPPING_PRECOMPILE_ADDRESS, data: calldata },
          "latest",
        ],
      }),
    });
    if (rpcResp.ok) {
      const rpcBody: { result?: unknown } = await rpcResp.json();
      const raw = rpcBody?.result;
      if (typeof raw === "string" && /^0x[0-9a-fA-F]{64}$/.test(raw)) {
        ss58 = encodeAccountId32(hexToBytes(raw), FINNEY_SS58_PREFIX);
        rpcOk = ss58 !== null;
      }
    }
  } catch {
    // RPC fetch failed -- ss58 stays null.
  }

  const payload: AddressMappingResultSnapshot = {
    schema_version: 1,
    h160: normalized,
    ss58,
    queried_at: queriedAt,
  };

  if (kv?.put) {
    try {
      await kv.put(cacheKey, JSON.stringify(payload), {
        expirationTtl: rpcOk
          ? ADDRESS_MAPPING_KV_TTL
          : ADDRESS_MAPPING_NEGATIVE_KV_TTL,
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
export async function loadAddressMapping(
  env: Env,
  h160: string,
  network?: ChainNetworkId,
): Promise<AddressMappingResult> {
  return {
    ...(await loadAddressMappingSnapshot(env, h160, network)),
    field_sources: ADDRESS_MAPPING_FIELD_SOURCES,
  };
}
