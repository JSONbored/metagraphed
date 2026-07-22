// Shared server-side SS58 codec for AccountId32-typed chain data (Workers
// runtime). @noble/hashes' blake2b is required here, not node:crypto's
// createHash("blake2b512") -- that throws "Digest method not supported" in
// workerd (confirmed live: account-balance.mjs's GET
// /api/v1/accounts/{ss58}/balance 500'd on every request for exactly this
// reason before the switch to @noble/hashes). Extracted from src/sudo-key.ts
// (#4310) so #4669/#4685/#4688's Postgres AccountId32 decoding reuses the one
// implementation already verified working in production, instead of a second
// hand-rolled copy.
import { blake2b } from "@noble/hashes/blake2.js";

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const SS58_PREIMAGE = new TextEncoder().encode("SS58PRE");

/** The Bittensor / generic-Substrate SS58 address format prefix. */
export const DEFAULT_SS58_PREFIX = 42;

// The general base58 "leading zero byte -> leading '1' character" convention
// doesn't apply to any caller here: the payload always starts with a
// non-zero network prefix byte, so the byte array this ever sees can't start
// with a zero byte.
function encodeBase58(bytes: Uint8Array): string {
  let num = 0n;
  for (const b of bytes) num = (num << 8n) | BigInt(b);
  let out = "";
  while (num > 0n) {
    const rem = num % 58n;
    out = BASE58_ALPHABET[Number(rem)] + out;
    num /= 58n;
  }
  return out;
}

/**
 * AccountId32 -> SS58: payload = prefix_byte + 32 account bytes, checksum =
 * blake2b512("SS58PRE" + payload)[0:2], address = base58(payload + checksum).
 * Returns null when `accountIdBytes` isn't exactly 32 bytes. Golden-value
 * tested in tests/ss58.test.mjs against real production data.
 */
export function encodeAccountId32(
  accountIdBytes: Uint8Array | number[],
  prefix = DEFAULT_SS58_PREFIX,
): string | null {
  const bytes =
    accountIdBytes instanceof Uint8Array
      ? accountIdBytes
      : Uint8Array.from(accountIdBytes);
  if (bytes.length !== 32) return null;
  const payload = new Uint8Array(1 + bytes.length);
  payload[0] = prefix;
  payload.set(bytes, 1);
  const preimage = new Uint8Array(SS58_PREIMAGE.length + payload.length);
  preimage.set(SS58_PREIMAGE, 0);
  preimage.set(payload, SS58_PREIMAGE.length);
  const hash = blake2b(preimage, { dkLen: 64 });
  const full = new Uint8Array(payload.length + 2);
  full.set(payload, 0);
  full[payload.length] = hash[0];
  full[payload.length + 1] = hash[1];
  return encodeBase58(full);
}

// Total byte length of a decoded single-byte-prefix AccountId32 SS58 address:
// 1 prefix byte + 32 account bytes + 2 checksum bytes (the same three parts
// encodeAccountId32 builds, in the same order).
const SS58_ACCOUNT_ID32_BYTE_LENGTH = 35;

// Reverse of encodeBase58 above, into a FIXED byte length rather than the
// natural minimum -- correct here because every caller already knows the
// target is exactly SS58_ACCOUNT_ID32_BYTE_LENGTH bytes and (per
// encodeBase58's own comment) the leading byte is always a non-zero network
// prefix, so the "leading zero byte -> leading '1' char" base58 edge case
// this deliberately doesn't handle can't arise for a well-formed address.
// Returns null for a character outside the alphabet or a value too large to
// fit in that many bytes (either way, not a valid encoding of that length).
function decodeBase58(str: string, byteLength: number): Uint8Array | null {
  let num = 0n;
  for (const char of str) {
    const index = BASE58_ALPHABET.indexOf(char);
    if (index === -1) return null;
    num = num * 58n + BigInt(index);
  }
  const bytes = new Uint8Array(byteLength);
  for (let i = byteLength - 1; i >= 0; i -= 1) {
    bytes[i] = Number(num & 0xffn);
    num >>= 8n;
  }
  return num === 0n ? bytes : null;
}

/**
 * SS58 -> AccountId32: the reverse of encodeAccountId32. Base58-decodes to
 * exactly SS58_ACCOUNT_ID32_BYTE_LENGTH bytes, splits prefix/pubkey/checksum,
 * and recomputes the same blake2b512("SS58PRE" + payload)[0:2] checksum
 * encodeAccountId32 writes -- returns null on any malformed input or checksum
 * mismatch (never throws on attacker-controlled strings, since this is the
 * entry point for a caller-supplied address in the wallet-auth verify route).
 * Round-trip tested against tests/ss58.test.mjs's existing encode golden
 * values.
 */
export function decodeSs58(
  address: unknown,
): { prefix: number; publicKey: Uint8Array } | null {
  if (typeof address !== "string" || address.length === 0) return null;
  const decoded = decodeBase58(address, SS58_ACCOUNT_ID32_BYTE_LENGTH);
  if (!decoded) return null;
  const payload = decoded.slice(0, 33);
  const checksum = decoded.slice(33, 35);
  const preimage = new Uint8Array(SS58_PREIMAGE.length + payload.length);
  preimage.set(SS58_PREIMAGE, 0);
  preimage.set(payload, SS58_PREIMAGE.length);
  const hash = blake2b(preimage, { dkLen: 64 });
  if (hash[0] !== checksum[0] || hash[1] !== checksum[1]) return null;
  return { prefix: payload[0], publicKey: payload.slice(1) };
}

function isByteArray(value: unknown, len: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === len &&
    value.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
  );
}

/**
 * indexer-rs's generic dynamic-SCALE-value dump wraps a Rust tuple-struct
 * with one field (like `AccountId32([u8; 32])`) in an extra array layer -- a
 * bare AccountId32 field arrives as `[[b0..b31]]`, not a flat 32-byte array.
 * Unwraps that one layer; returns null if `value` isn't that shape.
 */
function unwrapAccountId32Newtype(value: unknown): number[] | null {
  if (Array.isArray(value) && value.length === 1 && isByteArray(value[0], 32)) {
    return value[0];
  }
  return null;
}

/**
 * indexer-rs's `MultiAddress::Id(AccountId32)` variant arrives as
 * `{"name":"Id","values":[<AccountId32 newtype shape>]}`. Unwraps to the raw
 * 32 bytes for the `Id` variant only; returns null for `Index`/`Raw`/
 * `Address32`/`Address20` -- none of those carry a 32-byte AccountId32
 * payload in this shape (`Address20` is a 20-byte H160, `Index` is a compact
 * integer, `Raw` is arbitrary-length bytes), and none have been observed on
 * this chain, so declining is safer than guessing (#4669/#4688).
 */
export function unwrapMultiAddressId(value: unknown): number[] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as { name?: unknown; values?: unknown };
  if (
    candidate.name !== "Id" ||
    !Array.isArray(candidate.values) ||
    candidate.values.length !== 1
  ) {
    return null;
  }
  return unwrapAccountId32Newtype(candidate.values[0]);
}

/**
 * One-stop helper for a field the caller already knows is `AccountId32`-typed:
 * accepts the bare newtype-wrapped shape (`[[b0..b31]]`), a flat 32-element
 * byte array, or a `MultiAddress::Id` wrapper, and returns the SS58 string
 * (or null if the shape doesn't resolve to 32 bytes). This function does NOT
 * infer "is this an account" from shape alone -- a bare flat 32-byte array is
 * structurally indistinguishable from a `Hash`/`H256` (#4669's accepted
 * ambiguity note), so callers must gate on field-name/context first.
 */
export function normalizeAccountId32Field(
  value: unknown,
  prefix = DEFAULT_SS58_PREFIX,
): string | null {
  if (isByteArray(value, 32)) return encodeAccountId32(value, prefix);
  const unwrapped =
    unwrapAccountId32Newtype(value) ?? unwrapMultiAddressId(value);
  return unwrapped ? encodeAccountId32(unwrapped, prefix) : null;
}
