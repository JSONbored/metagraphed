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
