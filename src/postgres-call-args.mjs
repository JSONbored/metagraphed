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

// True when `value` is D1/indexer-rs's typed call_args field descriptor
// `{name, type, value}` -- duplicated from scale-normalize.mjs's identical
// check (not imported: that module deliberately treats AccountId32/byte-blob
// decoding as a sibling concern it never touches, so importing its type
// predicate here would be the only coupling between the two modules for a
// three-line shape test). Distinguished from isEnumTreeNode's `{name,
// values}` (2 keys, plural) by key count/name.
function isTypedFieldDescriptor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === 3 &&
    keys.includes("name") &&
    keys.includes("type") &&
    keys.includes("value") &&
    typeof value.name === "string" &&
    typeof value.type === "string"
  );
}

// True when a descriptor's own `type` string names an AccountId32 field
// directly, or a MultiAddress generic wrapping one (MultiAddress<AccountId32,
// ...>, Balances/Proxy/Contracts dest-style fields) -- the two concrete type
// strings indexer-rs's type_name() produces for values D1/substrate-interface
// already rendered as a bare SS58 string. normalizeAccountId32Field already
// unwraps both the bare newtype shape and the MultiAddress::Id wrapper, so a
// single call handles either type here.
function isAccountId32Type(type) {
  return type === "AccountId32" || type.startsWith("MultiAddress<");
}

// Duplicated from scale-normalize.mjs's identical COLLECTION_TYPE_RE/
// isCollectionType (not imported, same "one shared shape-test, not a real
// coupling" rationale as isTypedFieldDescriptor above) -- a collection-typed
// field's single-element `value` must never be attempted as a byte-blob
// here: it's shape-identical to a genuine 1-byte blob, and this ambiguity
// is deliberately resolved later, by decodeBTreeSetFields' narrow per-field
// allowlist (#4693), not by guessing from `type` + element count alone.
const COLLECTION_TYPE_RE =
  /(?:Vec|BoundedVec|WeakBoundedVec|BTreeSet|BoundedBTreeSet|BTreeMap|BoundedBTreeMap)</;
function isCollectionType(type) {
  return COLLECTION_TYPE_RE.test(type);
}

// Fallback name-guessing for an account field with NO type info of its own
// (a reconstructed nested call's args, which lose their per-field `type`
// string once repackaged, or a struct field nested inside an untyped
// `value`) -- a field carrying its own `type: "AccountId32"`/`"MultiAddress<...>"`
// is decoded via isAccountId32Type above instead, which doesn't need to
// guess. Mirrors src/chain-event-args.mjs's ACCOUNT_KEYS (the analogous
// chain_events.args decode, #4685) plus two additions specific to
// call_args' richer field vocabulary: "real" (Proxy.proxy's acting-account
// arg, extrinsics.ts:117-129)
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
//
// Excludes "Some"/"None" as the OUTER name: an Option<T> wrapping an
// enum-shaped T (e.g. Option<MultiSignature>, confirmed real shape --
// Drand.write_pulse's `signature`: {name:"Some", values:[{name:"Sr25519",
// values:[bytes]}]}) is structurally IDENTICAL to a nested-call encoding --
// both are "an outer {name,values} node wrapping exactly one inner
// {name,values}-shaped node." Without this guard, that Option wrapper gets
// misreconstructed as call_module:"Some", call_function:"Sr25519" (caught
// during #4692's Ethereum/EVM decoder work, which was the first real fixture
// exercising an Option wrapping an enum -- every #4691 fixture's wrapped
// value lacked its own string `.name`, so this never fired there). Safe:
// "Some"/"None" are Rust/Option-reserved names, never a real pallet
// identifier, so this can't produce a false negative for a genuine call.
function tryReconstructNestedCall(value) {
  if (!isEnumTreeNode(value) || value.values.length !== 1) return null;
  if (value.name === "Some" || value.name === "None") return null;
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

// Recursive walk: reconstructs nested calls at any depth, and decodes
// AccountId32/MultiAddress fields to SS58 and byte-blob fields to hex/text
// EVERYWHERE -- both at the top level of an extrinsic's own call_args and
// within an already-reconstructed nested call's args. `call` starts as the
// OUTER extrinsic's own {call_module, call_function} (threaded in from
// decodePostgresCallArgs' second argument) and is replaced with the NEAREST
// enclosing reconstructed call's own module/function once we descend into
// one, so decodeBytesField's callModule/callFunction-keyed textual-field
// lookup always matches the call that actually owns the field, not some
// outer ancestor.
//
// A typed descriptor (`{name, type, value}`, D1/indexer-rs's per-field
// shape) is decoded using its OWN declared `type` when it names an
// AccountId32/MultiAddress -- more reliable than the ACCOUNT_KEYS
// name-guessing heuristic below, which exists only for account fields with
// no type info of their own (an already-reconstructed nested call's args,
// which lose their per-field `type` string once repackaged, or a struct
// field nested inside an untyped `value`).
//
// Two DISTINCT call contexts are threaded through: `nestedCall` is null at
// the top level and becomes {call_module, call_function} only once we've
// descended into a reconstructed nested call -- it gates the GENERIC
// (untyped-shape) byte-blob heuristic below exactly as it always did,
// because a bare untyped array's "single-element collection vs. 1-byte
// blob" ambiguity (#4724) is only resolved later, by decodeBTreeSetFields'
// narrow per-field allowlist -- attempting it here for every untyped
// top-level array would silently corrupt a genuine single-element
// collection (confirmed against a real fixture: SubtensorModule.claim_root's
// `subnets: [[104]]`, #4693). `topCall` is the OUTER extrinsic's own
// {call_module, call_function} (from decodePostgresCallArgs' second
// argument) -- used ONLY within a typed descriptor whose `type` already
// rules out both AccountId32/MultiAddress and a collection generic, where
// the ambiguity above cannot occur (a declared non-collection scalar/hash/
// bytes type is unambiguously safe to byte-decode regardless of nesting).
function walk(value, keyHint, nestedCall, topCall) {
  const nested = tryReconstructNestedCall(value);
  if (nested) {
    const nextCall = {
      call_module: nested.call_module,
      call_function: nested.call_function,
    };
    return {
      ...nextCall,
      call_args: walk(nested.call_args, undefined, nextCall, topCall),
    };
  }
  if (isTypedFieldDescriptor(value)) {
    if (isAccountId32Type(value.type)) {
      return {
        name: value.name,
        type: value.type,
        value: normalizeAccountId32Field(value.value) ?? value.value,
      };
    }
    if (!isCollectionType(value.type)) {
      const bytes = unwrapByteArray(value.value);
      if (bytes && bytes.length > 0) {
        const ctx = nestedCall ?? topCall;
        return {
          name: value.name,
          type: value.type,
          value: decodeBytesField(
            ctx?.call_module,
            ctx?.call_function,
            value.name,
            bytes,
          ),
        };
      }
    }
    return {
      name: value.name,
      type: value.type,
      value: walk(value.value, value.name, nestedCall, topCall),
    };
  }
  if (isAccountField(keyHint)) {
    const ss58 = normalizeAccountId32Field(value);
    if (ss58) return ss58;
  }
  if (nestedCall) {
    const bytes = unwrapByteArray(value);
    if (bytes && bytes.length > 0) {
      return decodeBytesField(
        nestedCall.call_module,
        nestedCall.call_function,
        keyHint ?? "",
        bytes,
      );
    }
  }
  if (Array.isArray(value)) {
    return value.map((item) => walk(item, keyHint, nestedCall, topCall));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = walk(val, key, nestedCall, topCall);
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
 * MultiAddress/byte-blob fields to SS58/hex EVERYWHERE -- both at the
 * top level of the extrinsic's own call_args and within each reconstructed
 * nested call's args (fixed 2026-07-12: the top-level case was previously
 * left undecoded -- confirmed live, e.g. SubtensorModule.add_stake's
 * top-level `hotkey` field served as a raw `[[b0..b31]]` array instead of an
 * SS58 string, and Balances.transfer_keep_alive's top-level `dest`
 * (MultiAddress<AccountId32, ()>) likewise -- a gap this repo's own
 * `#4669`-era comments explicitly flagged as "not yet covered" and which
 * turned out to affect the vast majority of real extrinsics, since almost
 * every SubtensorModule/Balances call carries a top-level account field).
 * `topCall` is the OUTER extrinsic's own {call_module, call_function}
 * (pass row.call_module/row.call_function; used only for
 * decodeBytesField's textual-field lookup on a top-level byte-blob field
 * like System.remark's `remark`, harmless to omit otherwise). Deliberately
 * does NOT attempt to synthesize a nested call's own `call_hash`
 * (Multisig.as_multi's permanent, accepted gap -- indexer-rs's dynamic-value
 * dump has no equivalent of fetch-events.py's Python-side re-encode-and-hash
 * step; the reconstructed object simply has no `call_hash` key, same as
 * extrinsics.ts's normalizeIndexerRsCall). A no-op on D1's own call_args
 * shape historically (D1 is retired, #4772) and on a call_args tree with no
 * nested calls or account/byte fields at all -- safe to apply
 * unconditionally, same contract as normalizePostgresValue (#4690). */
export function decodePostgresCallArgs(value, topCall = null) {
  return walk(value, undefined, null, topCall);
}
