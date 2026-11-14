// Helpers for the account explorer (hotkey / coldkey ss58 lookups).
import { decodeSs58 } from "./ss58";

// Substrate ss58 addresses are base58 (no 0 O I l) and ~47–48 chars; Bittensor
// addresses start with 5. Keep this lenient — the backend validates definitively;
// the UI only rejects obviously-malformed input before issuing a request.
const SS58 = /^[1-9A-HJ-NP-Za-km-z]{46,49}$/;

/** True when a ref is a plausibly-valid ss58 account address. */
export function isValidSs58(ref: string): boolean {
  return SS58.test(ref.trim());
}

/** Encode a validated ss58 address as a single URL path segment. */
export function ss58PathSegment(ref: string): string {
  const trimmed = ref.trim();
  if (!isValidSs58(trimmed)) {
    throw new Error("Invalid ss58 address");
  }
  return encodeURIComponent(trimmed);
}

/** An Ethereum-style address: 0x + 20 bytes of hex.
 *
 * Deliberately requires the `0x`, matching `/api/v1/search/resolve` -- 40 bare
 * hex characters are far more likely to be something pasted by accident than an
 * EVM address, and the two recognisers disagreeing about that is how a paste
 * resolves one way in the search box and another on the page it lands on. */
const H160 = /^0x[0-9a-fA-F]{40}$/;

/** True when a ref is a well-formed EVM (H160) address. */
export function isValidH160(ref: string): boolean {
  return H160.test(ref.trim());
}

/** Lowercased, so a checksummed paste and an all-lower one are one cache key
 * and one URL rather than two. */
export function normalizeH160(ref: string): string {
  return ref.trim().toLowerCase();
}

/**
 * True when an address is a real SS58 address, CHECKSUM INCLUDED
 * (metagraphed-infra#376).
 *
 * `isValidSs58` above is a charset-and-length check, and it is the right shape
 * for its other callers: they format an address that already came from the
 * chain, or build an extrinsic from one the wallet supplied. Neither can be a
 * typo, and paying for a blake2b there would be work with no question behind it.
 *
 * A SEARCH BOX IS DIFFERENT. A one-character mutation of an ss58 is still 48
 * base58 characters, so the shape check happily offers it -- and the user lands
 * on an account page rendering "no activity", which reads as a fact about the
 * address rather than as "you mistyped it". `/api/v1/search/resolve` has always
 * verified the checksum for exactly that reason; the omnibox and the command
 * palette had their own recogniser and did not.
 *
 * No new dependency and no second implementation: `decodeSs58` from
 * `@jsonbored/chain-summaries` already does the base58 decode, the blake2b, and
 * the comparison, and it is already in this bundle.
 */
export function isChecksumValidSs58(address: unknown): boolean {
  if (typeof address !== "string") return false;
  const trimmed = address.trim();
  if (!trimmed) return false;
  return decodeSs58(trimmed)?.checksumValid === true;
}
