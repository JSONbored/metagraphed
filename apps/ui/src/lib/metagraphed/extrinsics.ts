// Helpers for the extrinsic (transaction) explorer — the sibling of blocks.ts.

const EXTRINSIC_HASH = /^0x[0-9a-fA-F]{1,128}$/;
/** block_number-extrinsic_index (e.g. 123456-2). Mirrors src/extrinsic-detail.mjs COMPOSITE_REF_RE,
 *  but disallows a leading-zero block number so omnibox decimal-block detection stays disjoint. */
const COMPOSITE_EXTRINSIC_REF = /^[1-9][0-9]*-[0-9]+$/;

/** True when a ref is a block_number-extrinsic_index composite label. */
export function isCompositeExtrinsicRef(ref: string): boolean {
  return COMPOSITE_EXTRINSIC_REF.test(ref);
}

/** True when a route/API ref is a 0x-prefixed extrinsic hash or a block#index composite. */
export function isValidExtrinsicHash(ref: string): boolean {
  return EXTRINSIC_HASH.test(ref) || COMPOSITE_EXTRINSIC_REF.test(ref);
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

/** Look up one named call-arg's value, regardless of which of the two valid
 * call_args shapes this extrinsic decoded to: the D1/fetch-events.py array of
 * `{name, type, value}` descriptors, or the Postgres/indexer-rs flat
 * `{name: value}` object (#4669 -- the two ingestion pipelines encode this
 * differently; `type` is decorative and never rendered by either shape's
 * branch in renderCallArgs, so only `name`/`value` need reconciling here).
 * Returns undefined when callArgs is neither shape or the name isn't found. */
function callArgValue(callArgs: unknown, name: string): unknown {
  if (Array.isArray(callArgs)) {
    return (callArgs as Array<{ name?: string | null; value?: unknown }>).find(
      (a) => a?.name === name,
    )?.value;
  }
  if (callArgs && typeof callArgs === "object") {
    return (callArgs as Record<string, unknown>)[name];
  }
  return undefined;
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
  const real = callArgValue(callArgs, "real");
  return typeof real === "string" ? real : null;
}

const CALL_HASH = /^0x[0-9a-fA-F]{64}$/;

/** A raw 32-byte array (indexer-rs's generic SCALE-value encoding for a
 * `[u8; 32]` field, #4669) hex-encoded to the same "0x..." string
 * fetch-events.py's Python decoder already produces. Only safe to apply at a
 * field position that's semantically KNOWN to be a hash (like `call_hash`) --
 * a bare 32-byte array is otherwise ambiguous with an AccountId32, which this
 * repo encodes SS58 instead, and indexer-rs's dump carries no type metadata
 * to tell the two apart generically. */
function hashBytesToHex(value: unknown): string | null {
  if (
    Array.isArray(value) &&
    value.length === 32 &&
    value.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
  ) {
    return `0x${(value as number[]).map((n) => n.toString(16).padStart(2, "0")).join("")}`;
  }
  return null;
}

/** The `call_hash` a `Multisig` call is keyed by, or null when this isn't a
 * Multisig call or no hash can be found. `approve_as_multi`/`cancel_as_multi`
 * carry `call_hash` directly as a top-level arg (they only approve/cancel a
 * pending call, never resubmit it); `as_multi` carries the full `call`
 * instead, decoded the same way as any other nested call -- its own
 * `call_hash` is one level down. Either way, this is the join key linking an
 * initiating `as_multi` to its later `approve_as_multi`s and final execution
 * (#4322).
 *
 * Postgres/indexer-rs parity (#4669): a direct `call_hash` arg reconciles --
 * fetch-events.py emits it as a hex string, indexer-rs as a raw 32-byte array
 * (hex-encoded here, unambiguous at this specific field). The NESTED case
 * (`as_multi`'s wrapped `call` computing its OWN call_hash) does NOT reconcile
 * -- indexer-rs's generic dynamic-value dump has no equivalent of
 * fetch-events.py's Python-side re-encode-and-hash step, and the wrapped
 * call's shape (a recursive `{name, values}` enum tree, not
 * `{call_module, call_function, ...}`) isn't `isDecodedCall`-shaped at all, so
 * this degrades to a clean `null` (no Related Multisig calls section) rather
 * than a wrong hash -- tracked as the remaining part of #4669. */
export function multisigCallHash(
  callModule: string | null | undefined,
  callArgs: unknown,
): string | null {
  if (callModule !== "Multisig") return null;
  const direct = callArgValue(callArgs, "call_hash");
  if (typeof direct === "string" && CALL_HASH.test(direct)) return direct;
  const directHex = hashBytesToHex(direct);
  if (directHex) return directHex;
  const wrapped = callArgValue(callArgs, "call");
  const nestedHash = isDecodedCall(wrapped) ? wrapped.call_hash : undefined;
  return typeof nestedHash === "string" && CALL_HASH.test(nestedHash) ? nestedHash : null;
}
