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

/** A fully-decoded nested call, as substrate-interface emits it inside a
 * parent's `call_args` -- a `Utility.batch*` inner call, a `Multisig`
 * `call` arg, or a `Proxy.proxy` `call` arg all share this identical shape
 * at any nesting depth (docs/block-explorer-data-model.md's "Nested-call
 * decode depth" note, #4319/4.1). */
export interface DecodedCall {
  call_module?: string | null;
  call_function?: string | null;
  call_args?: unknown;
  call_hash?: string | null;
  [key: string]: unknown;
}

/** True when a call_args value is itself a fully-decoded nested call, not a
 * plain scalar/struct -- lets a renderer tell "expand this as a call" from
 * "print this as JSON". */
export function isDecodedCall(value: unknown): value is DecodedCall {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).call_module === "string" &&
    typeof (value as Record<string, unknown>).call_function === "string"
  );
}

/** The real acting account for a `Proxy.proxy` call, or null when this isn't
 * a proxied call or its `real` arg is missing/malformed. The signer only
 * relayed the call on-chain -- `real` is the account it actually executes
 * as, easy to miss buried in a raw args table. */
export function proxyRealAccount(
  callModule: string | null | undefined,
  callFunction: string | null | undefined,
  callArgs: unknown,
): string | null {
  if (callModule !== "Proxy" || callFunction !== "proxy") return null;
  if (!Array.isArray(callArgs)) return null;
  const real = (callArgs as Array<{ name?: string | null; value?: unknown }>).find(
    (a) => a?.name === "real",
  );
  return typeof real?.value === "string" ? real.value : null;
}
