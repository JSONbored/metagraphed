// Pure Finney address validation. Serving readers must not import outbound RPC
// transport or account-balance capture merely to validate an SS58 address.
import { blake2b } from "@noble/hashes/blake2.js";

const SS58_BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const SS58_BASE58_INDEX = new Map(
  [...SS58_BASE58_ALPHABET].map((char, index) => [char, index]),
);
const FINNEY_SS58_PREFIX = 42;
const FINNEY_SS58_MIN_LENGTH = 47;
const FINNEY_SS58_MAX_LENGTH = 48;
const FINNEY_SS58_DECODED_LENGTH = 35;
const FINNEY_SS58_CHECKSUM_LENGTH = 2; // prefix < 64 → 2-byte SS58 checksum
const SS58_PREIMAGE = new TextEncoder().encode("SS58PRE");
const ACCOUNT_ID_LENGTH = 32;

function decodeBase58(value: string): Uint8Array | null {
  const bytes = [0];
  for (const char of value) {
    const carryStart = SS58_BASE58_INDEX.get(char);
    if (carryStart == null) return null;
    let carry = carryStart;
    for (let index = 0; index < bytes.length; index += 1) {
      carry += bytes[index] * 58;
      bytes[index] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const char of value) {
    if (char !== "1") break;
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

function verifyFinneySs58Checksum(decoded: Uint8Array): boolean {
  if (decoded.length !== FINNEY_SS58_DECODED_LENGTH) return false;
  const body = decoded.subarray(
    0,
    decoded.length - FINNEY_SS58_CHECKSUM_LENGTH,
  );
  const checksum = decoded.subarray(
    decoded.length - FINNEY_SS58_CHECKSUM_LENGTH,
  );
  const preimage = new Uint8Array(SS58_PREIMAGE.length + body.length);
  preimage.set(SS58_PREIMAGE, 0);
  preimage.set(body, SS58_PREIMAGE.length);
  const hash = blake2b(preimage, { dkLen: 64 });
  return hash[0] === checksum[0] && hash[1] === checksum[1];
}

export function isFinneySs58Address(value: string): boolean {
  if (
    value.length < FINNEY_SS58_MIN_LENGTH ||
    value.length > FINNEY_SS58_MAX_LENGTH
  ) {
    return false;
  }

  const decoded = decodeBase58(value);
  return (
    decoded?.length === FINNEY_SS58_DECODED_LENGTH &&
    decoded[0] === FINNEY_SS58_PREFIX &&
    verifyFinneySs58Checksum(decoded)
  );
}

// The 32-byte AccountId inside a finney SS58 (prefix byte, then AccountId32, then
// the 2-byte checksum). Callers shape-check the address with isFinneySs58Address.
export function accountIdFromSs58(ss58: string): Uint8Array | null {
  const decoded = decodeBase58(ss58);
  if (decoded?.length !== FINNEY_SS58_DECODED_LENGTH) return null;
  return decoded.subarray(1, 1 + ACCOUNT_ID_LENGTH);
}
