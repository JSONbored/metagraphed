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

function isPlainScalar(value) {
  return (
    value === null ||
    typeof value === "number" ||
    typeof value === "string" ||
    typeof value === "boolean"
  );
}

function isEnumTreeNode(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === 2 &&
    keys.includes("name") &&
    keys.includes("values") &&
    typeof value.name === "string" &&
    Array.isArray(value.values)
  );
}

function normalize(value) {
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
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value)) out[key] = normalize(val);
    return out;
  }
  return value;
}

/** Recursively applies the Option<T>/unit-enum/newtype-scalar normalization
 * rules described above. A no-op on already-D1-shaped data (D1's call_args
 * descriptors are `{name, type, value}` triples inside an array -- never a
 * bare two-key `{name, values}` object, never a real 1-element scalar array
 * in a value position), so this is safe to run unconditionally regardless of
 * which tier produced the row. */
export function normalizePostgresValue(value) {
  return normalize(value);
}
