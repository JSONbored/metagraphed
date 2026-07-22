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
// misidentifies it -- see src/extrinsics.ts's formatExtrinsic for the call
// order this depends on.
import { isEnumTreeNode } from "./scale-normalize.ts";
import { normalizeAccountId32Field } from "./ss58.ts";
import { unwrapByteArray, decodeBytesField, bytesToHex } from "./bytes.ts";
import { BTREESET_FIELDS } from "./postgres-collection-normalize.ts";

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

// A collection type specifically parameterized over `u8` (Vec<u8>,
// BoundedVec<u8,_>, WeakBoundedVec<u8,_>, optionally Option<...>-wrapped) is
// semantically a byte blob, not a "collection of typed things" -- unlike
// every OTHER collection type isCollectionType exists to protect (e.g.
// Vec<AccountId32>, BTreeSet<NetUid>), individually walking each element of
// a byte blob is meaningless; it needs the same hex/text treatment as any
// other opaque byte field. Confirmed live 2026-07-12:
// MevShield.submit_encrypted's `ciphertext` ("BoundedVec<u8, _>") and
// announce_next_key's `enc_key` ("Option<BoundedVec<u8, _>>") both stayed
// raw, undecoded byte arrays -- isCollectionType's (correct, for every
// OTHER case) broad match excluded them from the byte-blob branch below,
// with nothing narrower to catch this specific case instead.
const BYTE_BLOB_COLLECTION_RE =
  /(?:Vec|BoundedVec|WeakBoundedVec)<\s*u8\s*[,>]/;
function isByteBlobCollectionType(type) {
  return BYTE_BLOB_COLLECTION_RE.test(type);
}

// True when a descriptor's own non-collection type string names an opaque
// byte/hash scalar. This intentionally does NOT treat arbitrary scalar
// newtypes (Rate, u32, Compact<u64>, etc.) as byte blobs: single-field
// scalar wrappers such as [0] must survive until normalizePostgresValue can
// unwrap them to 0.
const BYTE_BLOB_SCALAR_RE = /^(?:H\d+|Hash|Bytes|\[u8;\s*\d+\])$/;
function isByteBlobScalarType(type) {
  return BYTE_BLOB_SCALAR_RE.test(type);
}

// Decodes a byte-blob-typed descriptor's value, which may either be a bare
// (possibly newtype-wrapped) byte array (BoundedVec<u8,_>) or an Option-
// wrapped one (Option<BoundedVec<u8,_>> -- confirmed live: announce_next_key's
// enc_key arrives as {name:"Some"/"None", values:[...]} at this point in the
// pipeline, since decodePostgresCallArgs runs BEFORE normalizePostgresValue's
// Option<T> unwrap). Returns `value` unchanged if neither shape matches
// (defensive; not expected for a real byte-blob-typed field).
function decodeByteBlobTypedValue(value, ctx, fieldName) {
  const bytes = unwrapByteArray(value);
  if (bytes && bytes.length > 0) {
    return decodeBytesField(
      ctx?.call_module,
      ctx?.call_function,
      fieldName,
      bytes,
    );
  }
  if (isEnumTreeNode(value)) {
    if (value.name === "None" && value.values.length === 0) return null;
    if (value.name === "Some" && value.values.length === 1) {
      const inner = unwrapByteArray(value.values[0]);
      if (inner && inner.length > 0) {
        return decodeBytesField(
          ctx?.call_module,
          ctx?.call_function,
          fieldName,
          inner,
        );
      }
    }
  }
  return value;
}

// SubtensorModule.set_root_claim_type's `new_root_claim_type` is a
// STRUCT-variant enum (RootClaimTypeEnum::KeepSubnets{subnets:
// BTreeSet<NetUid>}), unlike every OTHER enum shape this file/
// scale-normalize.mjs handles (all TUPLE-variant, `values` an ARRAY) --
// confirmed live 2026-07-12: its raw shape is {name:"KeepSubnets",
// values:{subnets:[[u16,...]]}}, `values` a plain OBJECT. isEnumTreeNode's
// own Array.isArray(values) check correctly does NOT recognize this as an
// enum-tree node at all, so neither this file's own enum handling nor
// normalizePostgresValue's ever touches the struct-variant's OWN inner
// fields -- `subnets` keeps its extra BTreeSet newtype-wrap layer
// ([[82,97]] instead of [82,97]) with nothing to unwrap it, the same
// #4693 ambiguity BTREESET_FIELDS resolves for claim_root's OWN top-level
// `subnets`, just one struct-field layer deeper. Only one struct-variant
// enum type is confirmed live so far; scoped narrowly to it (by its
// declared `type` string) rather than a generic "any struct-variant enum"
// rule, matching this file's established narrow-allowlist discipline.
function isStructVariantEnum(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.name === "string" &&
    value.values &&
    typeof value.values === "object" &&
    !Array.isArray(value.values)
  );
}

// Narrow allowlist for Vec<(_, AccountId32)>-shaped typed-descriptor fields
// whose account slot is nested inside each tuple element, keyed by
// "call_module.call_function.field_name" -> the account's 0-based tuple
// index. A raw tuple element carries no field name of its own (unlike a
// named struct field), so neither isAccountId32Type (needs the OUTER
// descriptor's own `type` string, which describes the whole Vec<(...)>, not
// each tuple slot) nor the ACCOUNT_KEYS name-guess (the only keyHint
// available this deep is the OUTER field's own name -- "children" here --
// which isn't itself account-shaped, unlike other_signatories above) can
// catch this. Confirmed live 2026-07-12: SubtensorModule.set_children's
// `children` (Vec<(u64, AccountId32)>, the child's own proportion + account)
// left its per-child AccountId32 (tuple index 1) as a raw byte array.
const TUPLE_ACCOUNT_FIELDS = new Map([
  ["SubtensorModule.set_children.children", 1],
]);

function decodeTupleAccountField(items, accountIndex) {
  return items.map((tuple) => {
    if (!Array.isArray(tuple) || accountIndex >= tuple.length) return tuple;
    const decoded = normalizeAccountId32Field(tuple[accountIndex]);
    if (decoded == null) return tuple;
    const out = tuple.slice();
    out[accountIndex] = decoded;
    return out;
  });
}

function decodeRootClaimTypeValue(value) {
  if (!isStructVariantEnum(value)) return value;
  const out = { name: value.name, values: { ...value.values } };
  const { subnets } = out.values;
  if (
    Array.isArray(subnets) &&
    subnets.length === 1 &&
    Array.isArray(subnets[0])
  ) {
    out.values.subnets = subnets[0];
  }
  return out;
}

// Fallback name-guessing for an account field with NO type info of its own
// (a reconstructed nested call's args, which lose their per-field `type`
// string once repackaged, or a struct field nested inside an untyped
// `value`) -- a field carrying its own `type: "AccountId32"`/`"MultiAddress<...>"`
// is decoded via isAccountId32Type above instead, which doesn't need to
// guess. Mirrors src/chain-event-args.ts's ACCOUNT_KEYS (the analogous
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
  // Added 2026-07-12 from a live sweep of call_args -- LimitOrders.
  // execute_batched_orders' per-order signer/fee_recipient are confirmed
  // 32-byte AccountId32 fields (same length/shape as the sibling `hotkey`
  // field in the same order struct, which was already correctly decoded).
  "delegate",
  "nominator",
  "owner",
  "target",
  "validator",
  "address",
  "real",
  "signer",
  "fee_recipient",
  // Added 2026-07-12 from a full 150-item ground-truth audit against live
  // served output. Multisig.approve_as_multi/as_multi's other_signatories
  // (type "Vec<AccountId32>") isn't an AccountId32/MultiAddress type itself
  // (isAccountId32Type doesn't match a collection type), so it falls through
  // to the generic recursive walk with keyHint="other_signatories" -- that
  // whole-array keyHint fails normalizeAccountId32Field once (it's an array
  // of accounts, not one), but the SAME keyHint then propagates unchanged
  // into the per-element recursion, where each individual (newtype-wrapped)
  // account now matches this name and decodes correctly. "signatories"
  // added defensively for the same field under an alternate name, unseen
  // live so far but equally plausible for a future runtime/pallet version.
  "other_signatories",
  "signatories",
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

// Substrate's identity-pallet-style Data::RawN(BoundedVec<u8,N>) variant
// family (RawN for N=0..128) -- confirmed live 2026-07-12:
// Commitments.set_commitment's info.fields[].RawN payload is genuinely
// human-readable free text (a URL, in the confirmed fixture), matching the
// pallet's own purpose for this enum family (short user-supplied metadata
// -- "Raw" here is Substrate's own name for exactly this: raw text data),
// unlike the narrow byte-blob-vs-text ambiguity TEXTUAL_FIELDS/
// isByteBlobCollectionType exist to resolve elsewhere in this file. This
// deeply-nested struct field is never reached by the nestedCall-gated
// generic byte-blob heuristic below (Commitments.set_commitment is the
// OUTER call, not itself nested inside a reconstructed RuntimeCall) or by
// isTypedFieldDescriptor (a RawN node has no `type` string -- it's a bare
// enum-tree node, one level below "info"'s own typed descriptor, which
// isCollectionType correctly leaves generically recursed since
// "CommitmentInfo<_>" is neither AccountId32/MultiAddress nor a
// Vec/BoundedVec/etc collection). Checked unconditionally (not gated by
// keyHint or nestedCall) since the RawN tag name itself is unambiguous --
// unlike a bare byte array, no OTHER shape in this codebase's confirmed
// data legitimately produces a 2-key {name,values} node named "RawN".
const RAW_DATA_VARIANT_RE = /^Raw\d+$/;

function isRawDataVariant(value) {
  return (
    isEnumTreeNode(value) &&
    RAW_DATA_VARIANT_RE.test(value.name) &&
    value.values.length === 1
  );
}

function decodeRawDataValue(value) {
  const bytes = unwrapByteArray(value.values[0]);
  if (!bytes) return value;
  try {
    return {
      [value.name]: new TextDecoder("utf-8", { fatal: true }).decode(
        Uint8Array.from(bytes),
      ),
    };
  } catch {
    // Malformed UTF-8 for a field expected to be textual -- fall back to
    // hex rather than producing mojibake, mirroring decodeBytesField's
    // identical fallback (src/bytes.mjs).
    return { [value.name]: bytesToHex(bytes) };
  }
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
  if (isRawDataVariant(value)) {
    return decodeRawDataValue(value);
  }
  if (isTypedFieldDescriptor(value)) {
    if (isAccountId32Type(value.type)) {
      return {
        name: value.name,
        type: value.type,
        value: normalizeAccountId32Field(value.value) ?? value.value,
      };
    }
    if (isByteBlobCollectionType(value.type)) {
      const ctx = nestedCall ?? topCall;
      return {
        name: value.name,
        type: value.type,
        value: decodeByteBlobTypedValue(value.value, ctx, value.name),
      };
    }
    if (value.type === "RootClaimTypeEnum") {
      return {
        name: value.name,
        type: value.type,
        value: decodeRootClaimTypeValue(value.value),
      };
    }
    if (isCollectionType(value.type)) {
      const tupleCtx = nestedCall ?? topCall;
      const tupleKey = `${tupleCtx?.call_module ?? ""}.${tupleCtx?.call_function ?? ""}.${value.name}`;
      const accountIndex = TUPLE_ACCOUNT_FIELDS.get(tupleKey);
      if (accountIndex != null && Array.isArray(value.value)) {
        return {
          name: value.name,
          type: value.type,
          value: decodeTupleAccountField(value.value, accountIndex),
        };
      }
    }
    // Only descriptor types that are semantically byte/hash scalars take this
    // typed byte-blob path. Other scalar/newtype wrappers (Rate/u32/U256/etc.)
    // can be shape-identical to a one-byte blob while carrying numeric data,
    // so they must fall through for normalizePostgresValue or the later
    // type-specific decoders to unwrap them without corrupting [0] -> "0x00".
    if (isByteBlobScalarType(value.type)) {
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
  // A generic enum-tree node (Option<T>'s Some/None, or any other tagged
  // union) that isn't a reconstructed nested call, a RawN text variant, or
  // an account-keyed MultiAddress::Id/AccountId32 wrap (all already handled
  // above -- this check runs AFTER isAccountField specifically so a real
  // `dest: {name:"Id", values:[[bytes]]}` MultiAddress field still gets
  // normalizeAccountId32Field's whole-shape unwrap-and-SS58-encode, not this
  // generic per-element walk) -- e.g. a nested call's own Option<u64> field,
  // `limit_price: {name:"Some", values:[0]}`. Must be walked as its OWN
  // shape (each element of `values` individually) rather than falling
  // through to the generic object recursion below, which would hand the
  // WHOLE `values` array to the nestedCall byte-blob heuristic under
  // keyHint="values" -- confirmed live 2026-07-12: a nested SubtensorModule.
  // remove_stake_full_limit (inside Utility.batch) with limit_price Some(0)
  // served `{"name":"Some","values":"0x00"}` instead of the scalar 0,
  // because `unwrapByteArray([0])` sees a single valid byte value and
  // decodeBytesField hex-encodes it -- actively WRONG, not just undecoded,
  // and only for values 0-255 (a genuine Some(32896091) survives unscathed,
  // since 32896091 fails the byte-array shape check and falls through
  // untouched). scale-normalize.mjs's normalizePostgresValue (which runs
  // AFTER this module) still does the actual Some/None/C-enum collapse on
  // the shape this preserves -- this branch only protects `values`'
  // elements from the byte-blob heuristic before that later pass gets a
  // chance to see them.
  if (isEnumTreeNode(value)) {
    return {
      name: value.name,
      values: value.values.map((item) =>
        walk(item, keyHint, nestedCall, topCall),
      ),
    };
  }
  // BTREESET_FIELDS-allowlisted fields (postgres-collection-normalize.ts)
  // are excluded from the generic byte-blob heuristic below -- confirmed
  // live 2026-07-12: a nested SubtensorModule.claim_root's `subnets` (inside
  // Utility.batch) is shape-identical to a genuine byte blob (a handful of
  // small integers), and without this exclusion unwrapByteArray/
  // decodeBytesField would hex-encode it into an opaque, actively WRONG
  // string (`[1,2,3,4,5]` -> "0x0102030405") before decodeBTreeSetFields
  // ever gets a chance to correctly unwrap the genuine collection -- this
  // module runs first in formatExtrinsic's pipeline, so leaving the field
  // untouched here is the only way that later pass can still see the real
  // array.
  const isNestedBTreeSetField =
    nestedCall &&
    BTREESET_FIELDS.has(
      `${nestedCall.call_module}.${nestedCall.call_function}.${keyHint ?? ""}`,
    );
  if (nestedCall && !isNestedBTreeSetField) {
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
