// Wallet-signature login for the account-gated fullnode RPC cluster (ADR
// 0021, #6835): challenge issuance/consumption, sr25519 signature
// verification, and key-management session tokens. This is the identity
// layer only -- the rpc_accounts upsert and the actual mg_... API key
// (src/api-keys.mjs, reused unchanged) live in workers/data-api.mjs, the one
// place with a Postgres binding.
//
// sr25519 verification is @scure/sr25519's `verify` -- a pure-JS, audited
// implementation (@noble/curves + @noble/hashes only, no WASM), confirmed
// working in a real wrangler dev Worker (see ADR 0021 section 2). The
// signing key material never reaches this codebase: the wallet extension
// signs client-side, this module only ever sees the resulting signature.
import { verify as sr25519Verify } from "@scure/sr25519";
import { DEFAULT_SS58_PREFIX, decodeSs58 } from "./ss58.mjs";
import { signPayload, timingSafeEqual } from "./webhooks.mjs";

const CHALLENGE_KV_PREFIX = "wallet-challenge:";
// Short-lived and single-use -- mirrors the negative-cache-style short-TTL
// pattern already used elsewhere (e.g. SUDO_KEY_NEGATIVE_KV_TTL): long enough
// for a wallet extension popup, short enough that an intercepted-but-unsigned
// challenge is worthless soon after.
export const WALLET_CHALLENGE_TTL_SECONDS = 300;
// Key-management session lifetime (ADR 0021 section 3's "signed token,
// simplest correct thing" decision -- see createSessionToken below).
export const SESSION_TTL_SECONDS = 3600;

function randomHex(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

/** The exact bytes a wallet extension signs (e.g. @polkadot/extension-dapp's
 * signRaw({ type: "bytes" })) -- deterministic from ss58 + nonce, so the
 * server reconstructs it for verification instead of storing the message
 * itself (only the nonce is persisted). */
export function walletChallengeMessage(ss58, nonce) {
  return `metagraphed wallet login\nss58: ${ss58}\nnonce: ${nonce}`;
}

/** Issues a fresh single-use nonce for `ss58` in KV. Returns a discriminated
 * result rather than null/throw so the caller (workers/data-api.mjs) can
 * distinguish a client error (bad ss58 -> 400) from an infra gap (KV
 * unbound -> 503) instead of collapsing both into one generic failure. */
export async function issueWalletChallenge(env, ss58) {
  const decoded = decodeSs58(ss58);
  if (!decoded || decoded.prefix !== DEFAULT_SS58_PREFIX) {
    return { ok: false, code: "invalid_ss58" };
  }
  const kv = env?.METAGRAPH_CONTROL;
  if (!kv?.put) {
    return { ok: false, code: "challenge_store_unavailable" };
  }
  const nonce = randomHex(16);
  await kv.put(`${CHALLENGE_KV_PREFIX}${ss58}`, nonce, {
    expirationTtl: WALLET_CHALLENGE_TTL_SECONDS,
  });
  return {
    ok: true,
    message: walletChallengeMessage(ss58, nonce),
    expiresInSeconds: WALLET_CHALLENGE_TTL_SECONDS,
  };
}

/** Verifies a caller's signed challenge and consumes the nonce -- deleted
 * whether or not the signature checks out, so a captured-but-unused
 * challenge can't be replayed after a failed attempt either. Never throws on
 * attacker-controlled input (malformed hex, wrong-length signature, and a
 * missing Schnorrkel marker all reach @scure/sr25519's own `abytes`/marker
 * assertions, which throw -- caught here and folded into `invalid_signature`
 * rather than a 500). */
export async function verifyWalletChallenge(env, ss58, signatureHex) {
  const decoded = decodeSs58(ss58);
  if (!decoded || decoded.prefix !== DEFAULT_SS58_PREFIX) {
    return { ok: false, code: "invalid_ss58" };
  }
  const kv = env?.METAGRAPH_CONTROL;
  if (!kv?.get) {
    return { ok: false, code: "challenge_store_unavailable" };
  }
  const key = `${CHALLENGE_KV_PREFIX}${ss58}`;
  const nonce = await kv.get(key);
  if (!nonce) {
    return { ok: false, code: "challenge_expired_or_missing" };
  }
  await kv.delete(key);

  if (
    typeof signatureHex !== "string" ||
    !/^[0-9a-f]{128}$/i.test(signatureHex)
  ) {
    return { ok: false, code: "invalid_signature" };
  }
  const message = new TextEncoder().encode(walletChallengeMessage(ss58, nonce));
  let verified;
  try {
    verified = sr25519Verify(
      message,
      hexToBytes(signatureHex.toLowerCase()),
      decoded.publicKey,
    );
  } catch {
    verified = false;
  }
  if (!verified) {
    return { ok: false, code: "invalid_signature" };
  }
  return { ok: true };
}

// --- key-management session tokens ---------------------------------------
// A stateless HMAC-signed bearer token scoped ONLY to the key-management
// routes (create/list/revoke THIS account's own keys) -- the actual RPC
// credential stays the mg_... API key (ADR 0021 section 3), never the
// session. No sessions table: verification is a pure re-sign-and-compare, so
// there's nothing to look up, and nothing to revoke early -- a leaked
// session's damage is bounded to its short TTL and to key-management actions
// on the one account it names.
function base64UrlEncodeBytes(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlDecodeToBytes(encoded) {
  const padded = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const pad =
    padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const binary = atob(padded + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function createSessionToken(secret, { accountId, ss58 }) {
  const payload = {
    account_id: accountId,
    ss58,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  const encoded = base64UrlEncodeBytes(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const signature = await signPayload(secret, encoded);
  return `${encoded}.${signature}`;
}

/** Verifies a session token's signature, expiry, and shape. Returns
 * { accountId, ss58 } on success, null on anything else -- expired, forged,
 * malformed, or truncated. */
export async function verifySessionToken(secret, token) {
  if (typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot === -1) return null;
  const encoded = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!encoded || !signature) return null;

  const expected = await signPayload(secret, encoded);
  if (!timingSafeEqual(signature, expected)) return null;

  let payload;
  try {
    payload = JSON.parse(
      new TextDecoder().decode(base64UrlDecodeToBytes(encoded)),
    );
  } catch {
    return null;
  }
  if (
    !payload ||
    typeof payload.account_id !== "number" ||
    typeof payload.ss58 !== "string" ||
    typeof payload.exp !== "number"
  ) {
    return null;
  }
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return { accountId: payload.account_id, ss58: payload.ss58 };
}
