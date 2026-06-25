// Helpers for the extrinsic (transaction) explorer — the sibling of blocks.ts.

const EXTRINSIC_HASH = /^0x[0-9a-fA-F]{1,128}$/;

/** True when a route/API ref is a 0x-prefixed extrinsic hash. */
export function isValidExtrinsicHash(ref: string): boolean {
  return EXTRINSIC_HASH.test(ref);
}

/** Encode a validated extrinsic hash as a single URL path segment. */
export function extrinsicHashPathSegment(ref: string): string {
  if (!isValidExtrinsicHash(ref)) {
    throw new Error("Invalid extrinsic hash");
  }
  return encodeURIComponent(ref);
}

/** Render an extrinsic's call as `module.function`; em dash when absent. */
export function extrinsicCall(module?: string | null, fn?: string | null): string {
  if (module && fn) return `${module}.${fn}`;
  return module || fn || "—";
}
