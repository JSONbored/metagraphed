// Nested-call decode helpers shared by the chain-summaries templates
// (#4319/#4669) -- extracted from apps/ui/src/lib/metagraphed/extrinsics.ts
// (#8525). The route-matching/display helpers that lived alongside these
// (isCompositeExtrinsicRef, isValidExtrinsicHash, extrinsicHashPathSegment,
// extrinsicCall, proxyRealAccount, multisigCallHash) are apps/ui-specific
// and stay there, importing the shared pieces below from this package.

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
 * to the D1 shape either way so callers don't need to know which pipeline
 * produced it. */
export function asDecodedCall(value: unknown): DecodedCall | null {
  if (isDecodedCall(value)) return value;
  return normalizeIndexerRsCall(value);
}

/** Look up one named call-arg's value, regardless of which of the two valid
 * call_args shapes this extrinsic decoded to: the D1/fetch-events.py array of
 * `{name, type, value}` descriptors, or the Postgres/indexer-rs flat
 * `{name: value}` object (#4669 -- the two ingestion pipelines encode this
 * differently; `type` is decorative and never rendered by either shape's
 * branch, so only `name`/`value` need reconciling here).
 * Returns undefined when callArgs is neither shape or the name isn't found. */
export function callArgValue(callArgs: unknown, name: string): unknown {
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
