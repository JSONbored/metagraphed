// Wallet-signature identity primitives, shared by two independent flows:
// the account-gated fullnode RPC cluster's login (ADR 0021, #6835) and
// self-serve alert-trigger issuance (#8374). Both need the same shape --
// challenge issuance/consumption, sr25519 signature verification, and a
// stateless signed token -- domain-separated by `purpose` so a signature
// proving one can't be replayed as proof of the other (see the
// WalletChallengePurpose comment below). This is the identity layer only --
// the rpc_accounts upsert and the actual mg_... API key (src/api-keys.mjs,
// reused unchanged) live in workers/data-api.ts, the one place with a
// Postgres binding.
//
// sr25519 verification is @scure/sr25519's `verify` -- a pure-JS, audited
// implementation (@noble/curves + @noble/hashes only, no WASM), confirmed
// working in a real wrangler dev Worker (see ADR 0021 section 2). The
// signing key material never reaches this codebase: the wallet extension
// signs client-side, this module only ever sees the resulting signature.
import { verify as sr25519Verify } from "@scure/sr25519";
import { DEFAULT_SS58_PREFIX, decodeSs58 } from "./ss58.ts";
import { signPayload, timingSafeEqual } from "./webhooks.ts";

const CHALLENGE_KV_PREFIX = "wallet-challenge:";
// Short-lived and single-use -- mirrors the negative-cache-style short-TTL
// pattern already used elsewhere (e.g. SUDO_KEY_NEGATIVE_KV_TTL): long enough
// for a wallet extension popup, short enough that an intercepted-but-unsigned
// challenge is worthless soon after.
export const WALLET_CHALLENGE_TTL_SECONDS = 300;
// Key-management session lifetime (ADR 0021 section 3's "signed token,
// simplest correct thing" decision -- see createSessionToken below).
export const SESSION_TTL_SECONDS = 3600;
// #8374: a signature is proof of "this ss58 signed THIS message", nothing
// more -- without a purpose in the message text, a signature captured for
// one flow (e.g. the RPC key-management login below) would verify just as
// well against a different flow's challenge for the same ss58, since both
// would otherwise sign an identical string. `purpose` domain-separates the
// message (and the KV nonce's own key, so two purposes issued concurrently
// for the same address don't clobber each other) per call site. The default
// (`"login"`) reproduces the original pre-#8374 message/key byte-for-byte --
// existing sessions and in-flight challenges for the RPC login flow are
// unaffected by this change.
export type WalletChallengePurpose = "login" | "watch";
// 90 days -- long enough that a subscriber doesn't re-verify every visit,
// short enough that a compromised token has a bounded blast radius; renewal
// is just re-running the challenge/verify flow, not a distinct code path.
export const WATCH_TOKEN_TTL_SECONDS = 90 * 24 * 3600;

type FailureResult = { ok: false; code: string };

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

/** The exact bytes a wallet extension signs (e.g. @polkadot/extension-dapp's
 * signRaw({ type: "bytes" })) -- deterministic from ss58 + nonce, so the
 * server reconstructs it for verification instead of storing the message
 * itself (only the nonce is persisted). Each purpose gets its own fixed,
 * human-readable preamble so a signature is legibly scoped to what it's
 * actually authorizing (see the module-level purpose comment above). */
export function walletChallengeMessage(
  ss58: string,
  nonce: string,
  purpose: WalletChallengePurpose = "login",
): string {
  const preamble =
    purpose === "watch"
      ? "metagraph.sh watch verification"
      : "metagraphed wallet login";
  return `${preamble}\nss58: ${ss58}\nnonce: ${nonce}`;
}

function challengeKvKey(ss58: string, purpose: WalletChallengePurpose): string {
  // "login" keeps the original, unprefixed key exactly -- byte-for-byte
  // compatible with any challenge already in flight when this shipped.
  return purpose === "login"
    ? `${CHALLENGE_KV_PREFIX}${ss58}`
    : `${CHALLENGE_KV_PREFIX}${purpose}:${ss58}`;
}

/** Issues a fresh single-use nonce for `ss58` in KV. Returns a discriminated
 * result rather than null/throw so the caller (workers/data-api.ts) can
 * distinguish a client error (bad ss58 -> 400) from an infra gap (KV
 * unbound -> 503) instead of collapsing both into one generic failure. */
export async function issueWalletChallenge(
  env: Env,
  ss58: string,
  purpose: WalletChallengePurpose = "login",
): Promise<
  FailureResult | { ok: true; message: string; expiresInSeconds: number }
> {
  const decoded = decodeSs58(ss58);
  if (!decoded || decoded.prefix !== DEFAULT_SS58_PREFIX) {
    return { ok: false, code: "invalid_ss58" };
  }
  const kv = env?.METAGRAPH_CONTROL;
  if (!kv?.put) {
    return { ok: false, code: "challenge_store_unavailable" };
  }
  const nonce = randomHex(16);
  await kv.put(challengeKvKey(ss58, purpose), nonce, {
    expirationTtl: WALLET_CHALLENGE_TTL_SECONDS,
  });
  return {
    ok: true,
    message: walletChallengeMessage(ss58, nonce, purpose),
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
/**
 * The byte sequences a wallet may actually have signed, for one challenge
 * message (#8645).
 *
 * Polkadot browser extensions do NOT sign the bytes you hand `signRaw({ type:
 * "bytes" })`. They wrap them in `<Bytes>` … `</Bytes>` first -- deliberately,
 * so a dapp can never trick a user into blind-signing something that is
 * actually a valid extrinsic payload. `@polkadot/util`'s `u8aWrapBytes` is the
 * canonical implementation; these are the same two literals.
 *
 * We verified only the UNWRAPPED form, so every signature a real extension
 * produced failed with `invalid_signature`. It shipped because the tests sign
 * with `@scure/sr25519` directly, which does not wrap -- the test path and the
 * production path differed in exactly the way that hides this, and the tests
 * were green the whole time. Reproduced against the real code before fixing:
 * an extension-style wrapped signature returned `invalid_signature`, the bare
 * one returned ok.
 *
 * Both forms are accepted rather than swapping one for the other. Wrapped is
 * what browser extensions send; bare is what a CLI signer, a backend service
 * or a test harness signing the message directly will send, and that path was
 * working. Accepting both costs one extra sr25519 verify on a route that is
 * already rate-limited to 10/min per IP, and breaks nobody.
 *
 * This is not a weakening: both candidates are built from the SAME
 * server-generated nonce, so an attacker gains no new signable text -- only
 * the framing differs, and the framing is not secret.
 */
export function challengeSignatureForms(message: Uint8Array): Uint8Array[] {
  const encoder = new TextEncoder();
  const prefix = encoder.encode("<Bytes>");
  const postfix = encoder.encode("</Bytes>");
  const wrapped = new Uint8Array(
    prefix.length + message.length + postfix.length,
  );
  wrapped.set(prefix, 0);
  wrapped.set(message, prefix.length);
  wrapped.set(postfix, prefix.length + message.length);
  // Wrapped first: browser extensions are the overwhelmingly common caller.
  return [wrapped, message];
}

export async function verifyWalletChallenge(
  env: Env,
  ss58: string,
  signatureHex: unknown,
  purpose: WalletChallengePurpose = "login",
): Promise<FailureResult | { ok: true }> {
  const decoded = decodeSs58(ss58);
  if (!decoded || decoded.prefix !== DEFAULT_SS58_PREFIX) {
    return { ok: false, code: "invalid_ss58" };
  }
  const kv = env?.METAGRAPH_CONTROL;
  if (!kv?.get) {
    return { ok: false, code: "challenge_store_unavailable" };
  }
  const key = challengeKvKey(ss58, purpose);
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
  const message = new TextEncoder().encode(
    walletChallengeMessage(ss58, nonce, purpose),
  );
  const signature = hexToBytes(signatureHex.toLowerCase());
  const verified = challengeSignatureForms(message).some((candidate) => {
    try {
      return sr25519Verify(candidate, signature, decoded.publicKey);
    } catch {
      return false;
    }
  });
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
function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlDecodeToBytes(encoded: string): Uint8Array {
  const padded = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const pad =
    padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const binary = atob(padded + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function createSessionToken(
  secret: string,
  { accountId, ss58 }: { accountId: number; ss58: string },
): Promise<string> {
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
export async function verifySessionToken(
  secret: string,
  token: unknown,
): Promise<{ accountId: number; ss58: string } | null> {
  if (typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot === -1) return null;
  const encoded = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!encoded || !signature) return null;

  const expected = await signPayload(secret, encoded);
  if (!timingSafeEqual(signature, expected)) return null;

  let payload: Record<string, unknown>;
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

// --- watch trigger-creation tokens (#8374) --------------------------------
// Same stateless HMAC-signed shape as createSessionToken/verifySessionToken
// above (no store, nothing to look up or revoke early -- a leaked token's
// damage is bounded to its TTL and to minting alert triggers for the one
// ss58 it names), but a DISTINCT secret from WALLET_SESSION_SECRET and a
// 90-day TTL instead of 1h: this token authorizes trigger creation over
// months, not a single key-management dashboard visit, so it must not be
// forgeable from (or accepted by) the session-token verifier and vice versa.

export async function createTriggerToken(
  secret: string,
  { ss58 }: { ss58: string },
): Promise<string> {
  const payload = {
    ss58,
    purpose: "trigger" as const,
    exp: Math.floor(Date.now() / 1000) + WATCH_TOKEN_TTL_SECONDS,
  };
  const encoded = base64UrlEncodeBytes(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const signature = await signPayload(secret, encoded);
  return `${encoded}.${signature}`;
}

/** Verifies a trigger-creation token's signature, expiry, purpose tag, and
 * shape. Returns `{ ss58 }` on success, null on anything else. The
 * `purpose === "trigger"` check (not just a shape check) means a
 * session-shaped token signed with a DIFFERENT secret would already fail the
 * signature compare, but it also stops a same-secret confusion if this
 * module ever grows a third stateless token kind sharing a signing key. */
export async function verifyTriggerToken(
  secret: string,
  token: unknown,
): Promise<{ ss58: string } | null> {
  if (typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot === -1) return null;
  const encoded = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!encoded || !signature) return null;

  const expected = await signPayload(secret, encoded);
  if (!timingSafeEqual(signature, expected)) return null;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(
      new TextDecoder().decode(base64UrlDecodeToBytes(encoded)),
    );
  } catch {
    return null;
  }
  if (
    !payload ||
    typeof payload.ss58 !== "string" ||
    payload.purpose !== "trigger" ||
    typeof payload.exp !== "number"
  ) {
    return null;
  }
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return { ss58: payload.ss58 };
}
