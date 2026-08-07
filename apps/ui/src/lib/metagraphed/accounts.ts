// Helpers for the account explorer (hotkey / coldkey ss58 lookups).

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
