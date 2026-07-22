// Helpers for the extrinsic (transaction) explorer — the sibling of blocks.ts.

import { unwrapByteArray, bytesToHex } from "./bytes";

const EXTRINSIC_HASH = /^0x[0-9a-fA-F]{1,128}$/;
/** block_number-extrinsic_index (e.g. 123456-2). Mirrors src/extrinsic-detail.ts COMPOSITE_REF_RE,
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

/** indexer-rs's generic dynamic-SCALE-value encoding of a RuntimeCall-typed
 * value (a nested call): `{name: "PalletName", values: [{name:
 * "function_name", values: <args>}]}` -- a single-variant enum wrapping
 * another single-variant enum, one level per nesting (#4669). Reconstructing
 * `call_module`/`call_function` from the two `name` fields is safe and
 * deterministic (pallet/function names are always plain strings here); this
 * is NOT the same risk as guessing whether a bare 32-byte array is a Hash or
 * an AccountId32 -- there's no ambiguity in an enum variant's own tag. The
 * reconstructed `call_args` is `values` UNCHANGED (still indexer-rs's native
 * shape recursively -- callArgValue/normalizeIndexerRsCall both already
 * handle it), so any byte-array fields inside stay raw arrays rather than a
 * guessed hex/SS58 encoding. */
export function normalizeIndexerRsCall(value: unknown): DecodedCall | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const outer = value as Record<string, unknown>;
  if (typeof outer.name !== "string") return null;
  if (!Array.isArray(outer.values) || outer.values.length !== 1) return null;
  const inner = outer.values[0];
  if (!inner || typeof inner !== "object" || Array.isArray(inner)) return null;
  const innerName = (inner as Record<string, unknown>).name;
  if (typeof innerName !== "string") return null;
  return {
    call_module: outer.name,
    call_function: innerName,
    call_args: (inner as Record<string, unknown>).values,
  };
}

/** A value that decodes to a nested call under EITHER shape -- D1's
 * `{call_module, call_function, ...}` (isDecodedCall) or indexer-rs's
 * `{name, values}` enum-tree wrapper (normalizeIndexerRsCall) -- normalized
 * to the D1 shape either way so callers (NestedCallCard, multisigCallHash's
 * nested branch) don't need to know which pipeline produced it. */
export function asDecodedCall(value: unknown): DecodedCall | null {
  if (isDecodedCall(value)) return value;
  return normalizeIndexerRsCall(value);
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
 * to tell the two apart generically. Reuses bytes.ts's depth-agnostic
 * unwrapByteArray/bytesToHex (#4689) rather than a second hardcoded-depth
 * hex-encoder, so a hash value works whether indexer-rs emits it flat
 * (confirmed for Multisig's call_hash) or newtype-wrapped. */
function hashBytesToHex(value: unknown): string | null {
  const bytes = unwrapByteArray(value);
  return bytes && bytes.length === 32 ? bytesToHex(bytes) : null;
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
 * -- asDecodedCall correctly recognizes indexer-rs's wrapped-call shape (the
 * module/function reconstruction is safe), but indexer-rs's dynamic-value
 * dump has no equivalent of fetch-events.py's Python-side re-encode-and-hash
 * step, so the reconstructed call simply has no `call_hash` field to read --
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
  const nestedHash = asDecodedCall(wrapped)?.call_hash;
  return typeof nestedHash === "string" && CALL_HASH.test(nestedHash) ? nestedHash : null;
}
