// Generic recursive normalizer for indexer-rs's (Postgres) dynamic-SCALE-value
// encoding of Option<T>, C-like unit-variant enums, and generic single-field
// newtype/tuple-struct wraps around a plain scalar -- three distinct Rust
// shapes that all serialize through the same `{name, values}` enum-tree
// grammar (or, for the newtype-scalar case, a bare 1-element array), while D1
// (fetch-events.py) already flattens each to its natural JS form (#4669,
// #4690). Bottom-up: children are normalized before a parent node is
// evaluated, so the same three rules apply at any nesting depth -- inside a
// Vec<T> element, a struct field, or a reconstructed nested call's own args
// alike.
//
// Deliberately NOT handled here (separate, sibling concerns):
// - AccountId32/MultiAddress::Id (#4688, src/ss58.mjs) and raw byte blobs
//   (#4689) are BOTH also "an array wrapping another array" -- this module's
//   newtype-scalar rule only fires when the wrapped element is a plain
//   SCALAR, never an array/object, so it never races with either of those.
// - An enum variant WITH associated data (Ethereum's `EIP1559`/`Call`,
//   Drand/MevShield/LimitOrders' `Sr25519`, i.e. `{name, values}` where
//   `values.length === 1` and the single element is itself an
//   object/array/struct) is left as-is at this level -- only its CONTENTS
//   are recursed into. Producing D1's single-key shorthand (`{EIP1559: {...}}`)
//   for that case is #4692's job, which reuses this same `{name, values}`
//   detection for its own final-step transform.
// - The nested-`RuntimeCall` reconstruction (`{name: "PalletName", values:
//   [{name: "function_name", values: <args>}]}`) is #4691's concern -- this
//   normalizer does not special-case it, so it passes through the generic
//   enum-with-data branch unchanged (a `values.length === 1` node whose
//   single element is itself an object) until #4691 recognizes it.
//
// #4724 CORRECTION: this module was originally documented (and tested) as an
// unconditional no-op on D1's own `{name, type, value}` call_args descriptor
// shape -- that claim was FALSE. D1's `value` field for a genuinely
// collection-typed field (Vec<T>/BTreeSet<T>/BoundedVec<T>/BTreeMap<K,V>) is
// a bare array of however many elements the call actually carried, and when
// that array happens to hold exactly one element, it is INDISTINGUISHABLE
// from the newtype-scalar wrap above by shape alone. Confirmed live in
// production (direct D1 query, blocks 8560000-8589000):
// SubtensorModule.set_mechanism_weights' dests/weights (10,129 occurrences
// EACH in just that window), set_weights' dests/weights (2,337 each),
// reveal_weights/reveal_mechanism_weights's uids/values (35-155 each),
// claim_root's subnets (84), Multisig.approve_as_multi/as_multi's
// other_signatories (8-9, string-typed -- confirming the fix must not assume
// numeric elements). All were being served with the field collapsed from
// e.g. `[0]` to a bare `0`, or `["5F..."]` to a bare `"5F..."`, silently
// changing the field's JSON type from array to scalar for consumers.
//
// The fix: D1's descriptor shape carries a sibling `type` string the
// Postgres/indexer-rs shapes never have -- isTypedFieldDescriptor +
// COLLECTION_TYPE_RE below use it to skip the newtype-scalar collapse
// specifically when `type` names a collection, regardless of element count.
// This is scoped to the `{name, type, value}` shape ONLY -- it does not
// change behavior for Postgres's untyped dump (which has no `type` field to
// consult and remains exactly as ambiguous as before; see
// postgres-collection-normalize.mjs's narrow per-field allowlist for how
// that side is handled instead).

function isPlainScalar(
  value: unknown,
): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "number" ||
    typeof value === "string" ||
    typeof value === "boolean"
  );
}

/** True when `value` is D1's per-field call_args descriptor shape: `{name,
 * type, value}`, where `type` is the Substrate/SCALE type string (e.g.
 * "Vec<u16>", "NetUid", "BTreeSet<NetUid>"). Distinguished from
 * isEnumTreeNode's `{name, values}` shape by key count/name (3 keys incl.
 * "type" + singular "value", vs. 2 keys incl. plural "values") -- the two
 * never collide. Postgres/indexer-rs's raw dump never produces this shape
 * (its call_args is either a flat `{fieldName: value}` object or a bare
 * array), so this is D1-specific by construction, not just by convention. */
interface TypedFieldDescriptor {
  name: string;
  type: string;
  value: unknown;
}

export function isTypedFieldDescriptor(
  value: unknown,
): value is TypedFieldDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const candidate = value as Record<string, unknown>;
  return (
    keys.length === 3 &&
    keys.includes("name") &&
    keys.includes("type") &&
    keys.includes("value") &&
    typeof candidate.name === "string" &&
    typeof candidate.type === "string"
  );
}

// Matches anywhere in the type string (not anchored) so a collection nested
// inside another generic -- e.g. a hypothetical "Option<Vec<u16>>" -- is
// still recognized; the cost of a false positive here (a genuine 1-tuple
// newtype-scalar stays wrapped in its array) is a cosmetic no-op, while the
// cost of a false negative (a genuine collection gets collapsed) is the data
// corruption this fix exists to close, so this deliberately errs toward
// over-preserving array-ness. Prefixes confirmed present in real D1
// call_args `type` strings (see the query note above): Vec, BoundedVec,
// BTreeSet, BTreeMap. WeakBoundedVec/BoundedBTreeSet/BoundedBTreeMap are
// Substrate's other standard bounded-collection wrappers -- included
// pre-emptively even though not yet observed in a real fixture, since they
// share the exact same "generic collection type name" convention.
const COLLECTION_TYPE_RE =
  /(?:Vec|BoundedVec|WeakBoundedVec|BTreeSet|BoundedBTreeSet|BTreeMap|BoundedBTreeMap)</;

function isCollectionType(type: string): boolean {
  return COLLECTION_TYPE_RE.test(type);
}

// A known-collection-typed descriptor's `value` must stay an array
// regardless of element count -- skips the newtype-scalar collapse for the
// OUTER array specifically, but still normalizes each element (an element
// could itself be an Option, nested struct, etc). Falls through to the
// generic normalize() if `value` isn't actually an array (defensive; not
// expected for a real collection-typed field).
function normalizeCollectionValue(value: unknown): unknown {
  if (!Array.isArray(value)) return normalize(value);
  return value.map(normalize);
}

/** True when `value` is indexer-rs's generic `{name, values}` enum-tree node
 * shape -- exported for #4691's nested-RuntimeCall reconstruction, which
 * needs the identical shape check to distinguish a nested call from an
 * ordinary enum-with-data node (both share this two-key shape; the
 * distinction is whether `values[0]` is ITSELF another such node). */
interface EnumTreeNode {
  name: string;
  values: unknown[];
}

export function isEnumTreeNode(value: unknown): value is EnumTreeNode {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const candidate = value as Record<string, unknown>;
  return (
    keys.length === 2 &&
    keys.includes("name") &&
    keys.includes("values") &&
    typeof candidate.name === "string" &&
    Array.isArray(candidate.values)
  );
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    // Generic single-field newtype/tuple-struct wrap around a plain scalar
    // (e.g. LimitOrders.execute_batched_orders' fee_rate: [0] -> 0). Scoped to
    // a SCALAR element specifically -- an array/object element here is the
    // AccountId32/byte-blob newtype-wrap family (#4688/#4689's territory),
    // left untouched by falling through to the generic element-map below.
    if (value.length === 1 && isPlainScalar(value[0])) {
      return value[0];
    }
    return value.map(normalize);
  }
  if (isEnumTreeNode(value)) {
    const { name, values } = value;
    if (name === "Some" && values.length === 1) {
      return normalize(values[0]);
    }
    if (name === "None" && values.length === 0) {
      return null;
    }
    if (values.length === 0) {
      // C-like unit-variant enum (ProxyType, RootClaimType, OrderType, ...) --
      // D1 renders the bare variant name as a string.
      return name;
    }
    // An enum variant WITH associated data (values.length >= 1, not Some/None)
    // -- out of scope here (see module header); preserve the tag/shape,
    // recurse only into the payload.
    return { name, values: values.map(normalize) };
  }
  if (isTypedFieldDescriptor(value)) {
    // #4724: consult the sibling `type` string before deciding what to do
    // with `value` -- the generic array-recursion below has no way to know,
    // from shape alone, whether a single-element array is a genuine
    // newtype-scalar wrap or a genuine collection that happens to hold one
    // entry. See COLLECTION_TYPE_RE above.
    return {
      name: value.name,
      type: value.type,
      value: isCollectionType(value.type)
        ? normalizeCollectionValue(value.value)
        : normalize(value.value),
    };
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) out[key] = normalize(val);
    return out;
  }
  return value;
}

/** Recursively applies the Option<T>/unit-enum/newtype-scalar normalization
 * rules described above. Safe to run unconditionally regardless of which tier
 * produced the row: on D1's own call_args shape (an array of `{name, type,
 * value}` descriptors), the isTypedFieldDescriptor branch reads each
 * descriptor's `type` string and only ever touches `value` in ways that
 * respect it -- a collection-typed field's `value` always stays an array
 * (any element count), and a non-collection field's `value` gets the same
 * generic normalization applied to any other position (#4724 -- this was
 * PREVIOUSLY (incorrectly) documented and tested as an unconditional no-op on
 * D1 data; that was false whenever a collection-typed field held exactly one
 * element, e.g. SubtensorModule.set_weights' dests/weights). */
export function normalizePostgresValue(value: unknown): unknown {
  return normalize(value);
}
