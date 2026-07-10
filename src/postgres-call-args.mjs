// Server-side reconstruction of indexer-rs's (Postgres) nested-RuntimeCall
// encoding within an extrinsic's call_args -- a generalized port of
// apps/ui/src/lib/metagraphed/extrinsics.ts:58-94's normalizeIndexerRsCall/
// asDecodedCall (#4676, client-only, one React route). This runs server-side
// so every consumer of the Postgres tier (REST, MCP once wired, third-party
// SDKs) sees the same reconstructed `{call_module, call_function, call_args}`
// shape D1/substrate-interface already produces natively, instead of
// indexer-rs's raw `{name: "PalletName", values: [{name: "function_name",
// values: <args>}]}` enum-tree dump (#4691).
//
// Must run BEFORE scale-normalize.mjs's normalizePostgresValue (#4690), not
// after or independently. Reconstruction needs the PRISTINE raw shape: a
// genuinely zero-argument nested call's inner function-node is
// `{name: "fn", values: []}` -- structurally identical to a C-like
// unit-variant enum (ProxyType::Any, etc.). If normalizePostgresValue's
// C-enum rule ran first, it would collapse that function-node to a bare
// string "fn" before this module ever saw the `{name,values}` wrapper to
// reconstruct, silently losing a valid zero-arg nested call. Reconstructing
// first sidesteps the ambiguity entirely: the reconstructed
// `{call_module, call_function, call_args}` shape has neither a "name" nor a
// "values" key (isEnumTreeNode requires both), so normalizePostgresValue's
// later pass over the combined tree recurses into it generically and never
// misidentifies it -- see src/extrinsics.mjs's formatExtrinsic for the call
// order this depends on.
import { isEnumTreeNode } from "./scale-normalize.mjs";
import { normalizeAccountId32Field } from "./ss58.mjs";
import { unwrapByteArray, decodeBytesField } from "./bytes.mjs";

// Field names decoded to SS58 within a reconstructed nested call's own args
// (#4691's scope -- top-level call_args fields of the same type are a
// separate, not-yet-covered gap, tracked on #4669). Mirrors
// src/chain-event-args.mjs's ACCOUNT_KEYS (the analogous chain_events.args
// decode, #4685) plus two additions specific to call_args' richer field
// vocabulary: "real" (Proxy.proxy's acting-account arg, extrinsics.ts:117-129)
// and the hotkey/coldkey SUFFIX rule below -- chain_events field names are
// short single words ("who", "from"), but SubtensorModule call_args commonly
// use compound names ("destination_coldkey", "origin_coldkey") that an
// exact-match set alone would miss (confirmed against real
// SubtensorModule.transfer_stake data, block 8587171/extrinsic_index 21).
const ACCOUNT_KEYS = new Set([
  "who",
  "account",
  "account_id",
  "accountid",
  "coldkey",
  "hotkey",
  "from",
  "to",
  "dest",
  "destination",
  "source",
  "delegate",
  "nominator",
  "owner",
  "target",
  "validator",
  "address",
  "real",
]);

function isAccountField(keyHint) {
  if (!keyHint) return false;
  const lower = keyHint.toLowerCase();
  return (
    ACCOUNT_KEYS.has(lower) ||
    lower.endsWith("_hotkey") ||
    lower.endsWith("_coldkey")
  );
}

// True when `value` is indexer-rs's generic dynamic-SCALE-value encoding of a
// RuntimeCall-typed field: a single-variant enum wrapping another
// single-variant enum, one level per nesting -- e.g.
// {name:"SubtensorModule", values:[{name:"commit_timelocked_mechanism_weights",
// values:{...}}]}. Reconstructing call_module/call_function from the two
// `name` tags is safe and deterministic (pallet/function names are always
// plain strings here, mirrors extrinsics.ts:60-71's identical rationale).
// Reuses isEnumTreeNode for the OUTER shape only -- the inner function-node's
// own `values` is the call's args and is NOT required to be an array (a
// named-struct-args call has an object there), so it can't reuse
// isEnumTreeNode (which requires Array.isArray(value.values)) for that half
// of the check.
function tryReconstructNestedCall(value) {
  if (!isEnumTreeNode(value) || value.values.length !== 1) return null;
  const inner = value.values[0];
  if (!inner || typeof inner !== "object" || Array.isArray(inner)) return null;
  if (typeof inner.name !== "string") return null;
  return {
    call_module: value.name,
    call_function: inner.name,
    // UNCHANGED, matching extrinsics.ts:83-84's identical choice -- decoded
    // recursively by walk() below, not re-derived here.
    call_args: inner.values,
  };
}

// Recursive walk: reconstructs nested calls at any depth, and -- only within
// an already-reconstructed call's own call_args (per #4691's scope) --
// decodes AccountId32/MultiAddress fields to SS58 and byte-blob fields to
// hex/text. `enclosingCall` is null at the top level (so call_args' own
// top-level fields are deliberately left untouched) and becomes
// `{callModule, callFunction}` for the NEAREST enclosing reconstructed call
// once we've descended into one, so decodeBytesField's callModule/
// callFunction-keyed textual-field lookup always uses the innermost call,
// not the outer extrinsic's own call_module/call_function.
function walk(value, keyHint, enclosingCall) {
  const nested = tryReconstructNestedCall(value);
  if (nested) {
    const call = {
      call_module: nested.call_module,
      call_function: nested.call_function,
    };
    return {
      ...call,
      call_args: walk(nested.call_args, undefined, call),
    };
  }
  if (enclosingCall && isAccountField(keyHint)) {
    const ss58 = normalizeAccountId32Field(value);
    if (ss58) return ss58;
  }
  if (enclosingCall) {
    const bytes = unwrapByteArray(value);
    if (bytes && bytes.length > 0) {
      return decodeBytesField(
        enclosingCall.call_module,
        enclosingCall.call_function,
        keyHint ?? "",
        bytes,
      );
    }
  }
  if (Array.isArray(value)) {
    return value.map((item) => walk(item, keyHint, enclosingCall));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = walk(val, key, enclosingCall);
    }
    return out;
  }
  return value;
}

/** Reconstructs indexer-rs's nested-RuntimeCall enum-tree shape into D1's
 * `{call_module, call_function, call_args}` shape at any nesting depth
 * (Proxy.proxy wrapping one call, Utility.batch wrapping an array of calls,
 * Multisig.as_multi/Sudo.sudo/Utility.batch_all composing three deep --
 * all confirmed against real production data), and decodes AccountId32/
 * MultiAddress/byte-blob fields within each reconstructed call's own args.
 * Deliberately does NOT attempt to synthesize a nested call's own
 * `call_hash` (Multisig.as_multi's permanent, accepted gap -- indexer-rs's
 * dynamic-value dump has no equivalent of fetch-events.py's Python-side
 * re-encode-and-hash step; the reconstructed object simply has no
 * `call_hash` key, same as extrinsics.ts's normalizeIndexerRsCall). A no-op
 * on D1's own call_args shape (an array of {name,type,value} descriptors --
 * "value" singular is never mistaken for "values" plural) and on a
 * call_args tree with no nested calls at all -- safe to apply
 * unconditionally regardless of which tier produced the row, same contract
 * as normalizePostgresValue (#4690). */
export function decodePostgresCallArgs(value) {
  return walk(value, undefined, null);
}
