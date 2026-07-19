// Self-serve API key generation, parsing, and hashing (ADR 0020, epic
// #6733/#6735). Pure/crypto-only helpers -- no I/O, no Postgres, no KV -- so
// the format/hashing logic is unit-testable in isolation from the mint/
// revoke/validate routes that use it (workers/data-api.mjs) and the
// per-request validation middleware (src/api-key-validation.mjs).
//
// Format: mg_<16-hex prefix>_<64-hex secret> (ADR 0020 section 2). The `mg_`
// tag makes a leaked key instantly recognizable as a metagraphed credential,
// matching the vendor-prefix convention GitHub/Stripe/OpenAI tokens use.
// The prefix is public (safe to log, safe as a cache key, safe in a support
// ticket); the secret is the actual credential and is hashed before it ever
// reaches storage -- see hashApiKeySecret below.
import { timingSafeEqual } from "./webhooks.mjs";

export const API_KEY_PREFIX_HEX_LENGTH = 16;
export const API_KEY_SECRET_HEX_LENGTH = 64;
const API_KEY_TAG = "mg";

export const API_KEY_PATTERN = new RegExp(
  `^${API_KEY_TAG}_[0-9a-f]{${API_KEY_PREFIX_HEX_LENGTH}}_[0-9a-f]{${API_KEY_SECRET_HEX_LENGTH}}$`,
);

function randomHex(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Mints a new key. Returns the parts separately (for storing `prefix` +
 * `secret_hash`) and the full string (returned to the caller exactly once,
 * at creation -- ADR 0020 section 2, mirrors src/alert-triggers.mjs's
 * owner_token convention: never echoed back on any later read). */
export function generateApiKey() {
  const prefix = randomHex(API_KEY_PREFIX_HEX_LENGTH / 2);
  const secret = randomHex(API_KEY_SECRET_HEX_LENGTH / 2);
  return { prefix, secret, full: `${API_KEY_TAG}_${prefix}_${secret}` };
}

/** Parses a caller-supplied key (an `Authorization: Bearer mg_...` header
 * value, or the bare key itself) into { prefix, secret }. Returns null for
 * anything malformed -- callers treat that as "no key provided", falling
 * through to the anonymous tier rather than erroring (this is an
 * optional-auth check, not a required one). */
export function parseApiKey(value) {
  if (typeof value !== "string") return null;
  const bare = value.startsWith("Bearer ") ? value.slice(7) : value;
  if (!API_KEY_PATTERN.test(bare)) return null;
  const [, prefix, secret] = bare.split("_");
  return { prefix, secret };
}

/** SHA-256 hex digest of the secret portion ONLY -- never the prefix, never
 * the full key. Storage compares against this, never the plaintext secret
 * (ADR 0020 section 2's deliberate departure from the owner_token
 * precedent). */
export async function hashApiKeySecret(secret) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(String(secret)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Compares a caller-provided secret against a stored hash by re-hashing and
 * comparing hex digests via timingSafeEqual. A SHA-256 digest has no
 * meaningful timing side-channel once both sides are fixed-length hex (ADR
 * 0020 section 2), but this stays timing-safe anyway rather than special-
 * casing the "safe to use ===" argument at the one call site that matters. */
export async function isValidApiKeySecret(providedSecret, storedHash) {
  if (
    typeof providedSecret !== "string" ||
    providedSecret.length === 0 ||
    typeof storedHash !== "string" ||
    storedHash.length === 0
  ) {
    return false;
  }
  const providedHash = await hashApiKeySecret(providedSecret);
  return timingSafeEqual(providedHash, storedHash);
}

// Deliberately loose (RFC 5322 is not worth reproducing here): this is an
// abuse-response contact field, not a login credential -- see ADR 0020
// section 3's "no verification in v1" decision. Rejects the empty/obviously-
// wrong-shape cases a fat-fingered submission would produce; nothing more.
const OWNER_CONTACT_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidOwnerContact(value) {
  return typeof value === "string" && OWNER_CONTACT_PATTERN.test(value);
}
