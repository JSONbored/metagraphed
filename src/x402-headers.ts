// Wire names shared by payment handling and dependency-light HTTP helpers.
/** Server -> client, alongside the 402 body. */
export const X402_REQUIRED_HEADER = "payment-required";
/** Client -> server, carrying the signed payload. */
export const X402_SIGNATURE_HEADER = "payment-signature";
/** Server -> client, carrying the settlement result. */
export const X402_RESPONSE_HEADER = "payment-response";
/** Browser clients must be able to read the quote and settlement receipt. */
export const X402_BROWSER_RESPONSE_HEADERS = [
  X402_REQUIRED_HEADER,
  X402_RESPONSE_HEADER,
] as const;
