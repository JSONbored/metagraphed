// Minimal, dependency-free SS58 address encoder for rendering raw account-id
// byte arrays (as they arrive in decoded chain-event args) as their canonical
// Substrate address string. The frontend intentionally ships no crypto
// library, so blake2b (used for the SS58 checksum) and base58 are vendored
// here as small self-contained routines, verified against known vectors in
// ss58.test.ts (Alice / Bob) — see #3984.

// ── blake2b (adapted from the public-domain blakejs reference) ──────────────
// 64-bit words are held as consecutive lo/hi uint32 pairs.

const BLAKE2B_IV32 = new Uint32Array([
  0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85, 0xfe94f82b, 0x3c6ef372, 0x5f1d36f1, 0xa54ff53a,
  0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c, 0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19,
]);

// prettier-ignore
const SIGMA8 = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3,
  11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4, 7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8,
  9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13, 2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9,
  12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11, 13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10,
  6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5, 10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0,
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3,
];
const SIGMA82 = new Uint8Array(SIGMA8.map((x) => x * 2));

// Reused scratch state — blake2b here is synchronous and single-shot per call.
const v = new Uint32Array(32);
const m = new Uint32Array(32);

function add64aa(a: number, b: number): void {
  const lo = v[a] + v[b];
  let hi = v[a + 1] + v[b + 1];
  if (lo >= 0x100000000) hi++;
  v[a] = lo;
  v[a + 1] = hi;
}

function add64ac(a: number, b0: number, b1: number): void {
  let lo = v[a] + b0;
  if (b0 < 0) lo += 0x100000000;
  let hi = v[a + 1] + b1;
  if (lo >= 0x100000000) hi++;
  v[a] = lo >>> 0;
  v[a + 1] = hi >>> 0;
}

function get32(arr: Uint8Array, i: number): number {
  return (arr[i] ^ (arr[i + 1] << 8) ^ (arr[i + 2] << 16) ^ (arr[i + 3] << 24)) >>> 0;
}

function mix(a: number, b: number, c: number, d: number, ix: number, iy: number): void {
  const x0 = m[ix];
  const x1 = m[ix + 1];
  const y0 = m[iy];
  const y1 = m[iy + 1];
  add64aa(a, b);
  add64ac(a, x0, x1);
  let xor0 = v[d] ^ v[a];
  let xor1 = v[d + 1] ^ v[a + 1];
  v[d] = xor1;
  v[d + 1] = xor0;
  add64aa(c, d);
  xor0 = v[b] ^ v[c];
  xor1 = v[b + 1] ^ v[c + 1];
  v[b] = (xor0 >>> 24) ^ (xor1 << 8);
  v[b + 1] = (xor1 >>> 24) ^ (xor0 << 8);
  add64aa(a, b);
  add64ac(a, y0, y1);
  xor0 = v[d] ^ v[a];
  xor1 = v[d + 1] ^ v[a + 1];
  v[d] = (xor0 >>> 16) ^ (xor1 << 16);
  v[d + 1] = (xor1 >>> 16) ^ (xor0 << 16);
  add64aa(c, d);
  xor0 = v[b] ^ v[c];
  xor1 = v[b + 1] ^ v[c + 1];
  v[b] = (xor1 >>> 31) ^ (xor0 << 1);
  v[b + 1] = (xor0 >>> 31) ^ (xor1 << 1);
}

interface Blake2bCtx {
  b: Uint8Array;
  h: Uint32Array;
  t: number;
  c: number;
}

function compress(ctx: Blake2bCtx, last: boolean): void {
  for (let i = 0; i < 16; i++) {
    v[i] = ctx.h[i];
    v[i + 16] = BLAKE2B_IV32[i];
  }
  v[24] = (v[24] ^ ctx.t) >>> 0;
  v[25] = (v[25] ^ (ctx.t / 0x100000000)) >>> 0;
  if (last) {
    v[28] = ~v[28];
    v[29] = ~v[29];
  }
  for (let i = 0; i < 32; i++) m[i] = get32(ctx.b, 4 * i);
  for (let i = 0; i < 12; i++) {
    const o = i * 16;
    mix(0, 8, 16, 24, SIGMA82[o + 0], SIGMA82[o + 1]);
    mix(2, 10, 18, 26, SIGMA82[o + 2], SIGMA82[o + 3]);
    mix(4, 12, 20, 28, SIGMA82[o + 4], SIGMA82[o + 5]);
    mix(6, 14, 22, 30, SIGMA82[o + 6], SIGMA82[o + 7]);
    mix(0, 10, 20, 30, SIGMA82[o + 8], SIGMA82[o + 9]);
    mix(2, 12, 22, 24, SIGMA82[o + 10], SIGMA82[o + 11]);
    mix(4, 14, 16, 26, SIGMA82[o + 12], SIGMA82[o + 13]);
    mix(6, 8, 18, 28, SIGMA82[o + 14], SIGMA82[o + 15]);
  }
  for (let i = 0; i < 16; i++) ctx.h[i] = (ctx.h[i] ^ v[i] ^ v[i + 16]) >>> 0;
}

/** blake2b digest of `input` with the given output length (default 64 bytes). */
export function blake2b(input: Uint8Array, outlen = 64): Uint8Array {
  const ctx: Blake2bCtx = { b: new Uint8Array(128), h: new Uint32Array(BLAKE2B_IV32), t: 0, c: 0 };
  ctx.h[0] = (ctx.h[0] ^ 0x01010000 ^ outlen) >>> 0;
  for (let i = 0; i < input.length; i++) {
    if (ctx.c === 128) {
      ctx.t += ctx.c;
      compress(ctx, false);
      ctx.c = 0;
    }
    ctx.b[ctx.c++] = input[i];
  }
  ctx.t += ctx.c;
  while (ctx.c < 128) ctx.b[ctx.c++] = 0;
  compress(ctx, true);
  const out = new Uint8Array(outlen);
  for (let i = 0; i < outlen; i++) out[i] = (ctx.h[i >> 2] >> (8 * (i & 3))) & 0xff;
  return out;
}

// ── base58 ──────────────────────────────────────────────────────────────────
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** base58-encode a byte array (Bitcoin/Substrate alphabet). */
export function base58Encode(bytes: Uint8Array): string {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let leadingZeros = 0;
  for (const byte of bytes) {
    if (byte === 0) leadingZeros++;
    else break;
  }
  let out = "1".repeat(leadingZeros);
  for (let i = digits.length - 1; i >= 0; i--) out += BASE58_ALPHABET[digits[i]];
  return out;
}

/** base58-decode a string (Bitcoin/Substrate alphabet). `null` on any character outside the alphabet — mirrors {@link base58Encode}'s digit-array algorithm in reverse. */
export function base58Decode(input: string): Uint8Array | null {
  const bytes = [0];
  for (const char of input) {
    const value = BASE58_ALPHABET.indexOf(char);
    if (value === -1) return null;
    let carry = value;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let leadingZeros = 0;
  for (const char of input) {
    if (char === "1") leadingZeros++;
    else break;
  }
  const out = new Uint8Array(leadingZeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[leadingZeros + bytes.length - 1 - i] = bytes[i];
  return out;
}

// ── SS58 ─────────────────────────────────────────────────────────────────────
const SS58_PREFIX = new TextEncoder().encode("SS58PRE");

/** The Bittensor / generic-Substrate address format prefix. */
export const DEFAULT_SS58_FORMAT = 42;

/**
 * Encode a 32-byte public key as its SS58 address string. `format` is the
 * network prefix byte (42 = generic Substrate, used by Bittensor). Returns
 * `null` if the input isn't a 32-byte account id.
 */
export function encodeSs58(pubkey: Uint8Array, format = DEFAULT_SS58_FORMAT): string | null {
  if (pubkey.length !== 32) return null;
  const payload = new Uint8Array(1 + pubkey.length);
  payload[0] = format;
  payload.set(pubkey, 1);
  const input = new Uint8Array(SS58_PREFIX.length + payload.length);
  input.set(SS58_PREFIX);
  input.set(payload, SS58_PREFIX.length);
  const checksum = blake2b(input, 64);
  const full = new Uint8Array(payload.length + 2);
  full.set(payload);
  full.set(checksum.slice(0, 2), payload.length);
  return base58Encode(full);
}

export interface DecodedSs58 {
  /** True only for the fully-decoded, checksum-verified 32-byte-account shape. */
  valid: boolean;
  /** Network prefix byte, or -1 when `extendedFormat` is true (not decoded). */
  format: number;
  /** The 32-byte public key, present only when `valid` is true. */
  pubkey: Uint8Array | null;
  checksumValid: boolean;
  /**
   * SS58 prefixes 64-127 use a 2-byte bit-packed encoding this app doesn't
   * implement — every chain a Bittensor user would realistically encounter
   * (Polkadot 0, Kusama 2, generic Substrate/Bittensor 42) uses the simple
   * single-byte form (0-63), so this just flags the shape rather than
   * guessing at an unverified bit-unpacking.
   */
  extendedFormat: boolean;
}

/**
 * Decode an SS58 address string back to its network prefix and public key,
 * verifying the checksum. Only handles the single-byte-prefix, 32-byte
 * account-id shape {@link encodeSs58} produces (what every real Bittensor
 * hotkey/coldkey is) — returns `null` for malformed base58 or a length that
 * doesn't match that shape, and `extendedFormat: true` (no pubkey) for a
 * structurally-plausible but unsupported 2-byte-prefix address.
 */
export function decodeSs58(address: string): DecodedSs58 | null {
  const bytes = base58Decode(address.trim());
  if (!bytes || bytes.length < 3) return null;

  const first = bytes[0];
  if (first >= 128) return null;

  if (first > 63) {
    return { valid: false, format: -1, pubkey: null, checksumValid: false, extendedFormat: true };
  }

  if (bytes.length !== 35) return null;

  const format = first;
  const payload = bytes.slice(0, 33);
  const checksum = bytes.slice(33, 35);
  const input = new Uint8Array(SS58_PREFIX.length + payload.length);
  input.set(SS58_PREFIX);
  input.set(payload, SS58_PREFIX.length);
  const expectedChecksum = blake2b(input, 64);
  const checksumValid = checksum[0] === expectedChecksum[0] && checksum[1] === expectedChecksum[1];

  return {
    valid: checksumValid,
    format,
    pubkey: checksumValid ? payload.slice(1) : null,
    checksumValid,
    extendedFormat: false,
  };
}
