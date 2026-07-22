// Live finney Sudo::Key holder via RPC (#4310/2.4, re-scoped from the original
// Senate/Council membership framing — see #4310's audit; subtensor has no such
// pallet). Sudo::Key is a plain StorageValue (Optional<AccountId32>), so its
// storage key is the fixed twox128("Sudo") ++ twox128("Key") prefix with no
// further hashing — confirmed live against finney (bittensor 10.5.0,
// substrate.create_storage_key("Sudo", "Key")), so it's hardcoded rather than
// computed at runtime. Mirrors src/account-balance.mjs's live-RPC + KV-cache
// shape for GET /api/v1/accounts/{ss58}/balance.

// Server-side SS58 encoding lives in src/ss58.mjs (extracted #4688) -- see
// that module's header for why @noble/hashes' blake2b is required over
// node:crypto's createHash("blake2b512") (unsupported in workerd).
import { encodeAccountId32 } from "./ss58.ts";

type Row = Record<string, unknown>;

const SUDO_KEY_STORAGE_KEY =
  "0x5c0d1176a568c1f92944340dbfed9e9c530ebca703c85910e7164cb7d1c9e47b";
export const SUDO_KEY_KV_TTL = 3600; // seconds — the sudo key changes extremely rarely
export const SUDO_KEY_NEGATIVE_KV_TTL = 10; // seconds
export const SUDO_KEY_RPC_TIMEOUT_MS = 5000;
const FINNEY_RPC_URL = "https://entrypoint-finney.opentensor.ai:443";
const FINNEY_SS58_PREFIX = 42;

// The one call site already validated a "0x"-prefixed 64-hex-char string via
// regex, so this only ever strips that guaranteed prefix — not a general
// hex-or-0x-hex parser.
function hexToBytes(hex: string): Uint8Array {
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
export async function loadSudoKey(env: Env): Promise<Row> {
  const cacheKey = "sudo:key";
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
  let hotkey: string | null = null;
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
      const rpcBody = (await rpcResp.json()) as Row;
      const raw = rpcBody?.result;
      if (typeof raw === "string" && /^0x[0-9a-fA-F]{64}$/.test(raw)) {
        hotkey = encodeAccountId32(hexToBytes(raw), FINNEY_SS58_PREFIX);
        rpcOk = true;
      } else if (raw === null) {
        // Storage genuinely unset (sudo renounced) — a valid, not-failed result.
        rpcOk = true;
      }
    }
  } catch {
    // RPC fetch failed — hotkey stays null.
  }

  const payload: Row = {
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
