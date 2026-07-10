// Unwraps indexer-rs's (Postgres) BTreeSet<T> extra array-nesting layer for
// specific, confirmed call-arg fields (#4693) -- e.g.
// SubtensorModule.claim_root's `subnets`: D1 serves `[104]`, Postgres serves
// `[[104]]` (confirmed real data, block 8587445/extrinsic_index 19, 162
// in-window occurrences).
//
// Deliberately scoped to named (callModule, callFunction, fieldName)
// triples, NOT a generic "strip any outer array wrapping another array"
// rule. That shape is structurally IDENTICAL to an AccountId32/MultiAddress/
// H160/Hash newtype wrap (src/ss58.mjs, src/bytes.mjs,
// src/indexer-rs-ethereum-decode.mjs's territory) -- unwrapping it
// unconditionally here would silently corrupt those fields wherever this
// module's dispatch and theirs might overlap. A BTreeSet's element count is
// unbounded (0, 1, many), unlike a fixed-width byte/account wrap, but
// nothing in the JSON shape itself distinguishes "a 1-element BTreeSet" from
// "a 1-element newtype wrap around something array-shaped" -- so this stays
// an opt-in allowlist of fields independently confirmed to be BTreeSet-typed,
// the same discipline #4692's Ethereum/EVM decoders already established.
//
// Chained AFTER scale-normalize.mjs's normalizePostgresValue (#4690) in
// formatExtrinsic, not before -- ordering doesn't matter for correctness
// here (verified: normalizePostgresValue's generic newtype-scalar rule
// already happens to partially collapse a SINGLE-element BTreeSet as a side
// effect, e.g. [[104]] -> [104], via its own unrelated scalar-unwrap logic;
// this module's unwrap step is a no-op on that already-correct shape since
// unwrapping requires the wrapped element to STILL be an array. For a
// MULTI-element BTreeSet, normalizePostgresValue leaves the outer wrap
// completely untouched -- e.g. [[104,71,9]] stays [[104,71,9]] -- which is
// exactly what this module then unwraps to [104,71,9]), but running after
// keeps the two passes' responsibilities cleanly separated: generic
// Option/enum/scalar shapes first, named-field collection shapes second.
const BTREESET_FIELDS = new Set(["SubtensorModule.claim_root.subnets"]);

function unwrapBTreeSetLayer(value) {
  return Array.isArray(value) && value.length === 1 && Array.isArray(value[0])
    ? value[0]
    : value;
}

/** Unwraps BTreeSet-typed fields in callArgs for the small set of
 * (callModule, callFunction, fieldName) triples confirmed to need it. A
 * no-op (returns callArgs unchanged, or with only the confirmed fields
 * touched) for every other call -- safe to apply unconditionally in
 * formatExtrinsic regardless of which tier produced the row, same contract
 * as normalizePostgresValue (#4690) and decodePostgresCallArgs (#4691). */
export function decodeBTreeSetFields(callModule, callFunction, callArgs) {
  if (!callArgs || typeof callArgs !== "object" || Array.isArray(callArgs)) {
    return callArgs;
  }
  const out = { ...callArgs };
  for (const key of Object.keys(callArgs)) {
    if (BTREESET_FIELDS.has(`${callModule}.${callFunction}.${key}`)) {
      out[key] = unwrapBTreeSetLayer(callArgs[key]);
    }
  }
  return out;
}
