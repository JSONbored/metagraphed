// Unwraps indexer-rs's (Postgres) BTreeSet<T> extra array-nesting layer for
// specific, confirmed call-arg fields (#4693) -- e.g.
// SubtensorModule.claim_root's `subnets`: D1 serves `[104]`, Postgres serves
// `[[104]]` (confirmed real data, block 8587445/extrinsic_index 19, 162
// in-window occurrences).
//
// Also covers a BoundedVec<T,_> holding a single struct-typed element, the
// same "extra array layer around a bounded collection" shape as a BTreeSet --
// found by the 2026-07-14/15 exhaustive decode audit on two call types:
// LimitOrders.execute_batched_orders's `orders`
// (BoundedVec<SignedOrder<AccountId32>,_>, block 8617315/extrinsic_index 18:
// served `[[{"order":{...}}]]` instead of `[{"order":{...}}]`) and
// Commitments.set_commitment's `info.fields`
// (BoundedVec<Data,_>, block 8623300/extrinsic_index 12: served
// `{"fields":[[{"Raw100":"..."}]]}` instead of `{"fields":[{"Raw100":"..."}]}`).
//
// Deliberately scoped to named (callModule, callFunction, fieldName)
// triples, NOT a generic "strip any outer array wrapping another array"
// rule. That shape is structurally IDENTICAL to an AccountId32/MultiAddress/
// H160/Hash newtype wrap (src/ss58.mjs, src/bytes.mjs,
// src/indexer-rs-ethereum-decode.ts's territory) -- unwrapping it
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
//
// Exported (not just used internally) because src/postgres-call-args.ts's
// walk() also needs it: confirmed live 2026-07-12, a NESTED claim_root call
// (inside Utility.batch) has its `subnets` field corrupted from an array
// into an opaque hex STRING by walk()'s own generic nestedCall byte-blob
// heuristic -- the exact #4724 collection-vs-blob ambiguity this module's
// header already describes, except walk() runs BEFORE this module ever gets
// a chance to unwrap the (by-then-already-destroyed) field. walk() checks
// this same set to skip that heuristic for an allowlisted field instead.
export const BTREESET_FIELDS = new Set([
  "SubtensorModule.claim_root.subnets",
  "LimitOrders.execute_batched_orders.orders",
  "Commitments.set_commitment.fields",
]);

function unwrapBTreeSetLayer(value: unknown): unknown {
  return Array.isArray(value) && value.length === 1 && Array.isArray(value[0])
    ? value[0]
    : value;
}

interface ReconstructedCall {
  call_module: string;
  call_function: string;
  call_args: unknown;
}

// True for postgres-call-args.ts's tryReconstructNestedCall output --
// {call_module, call_function, call_args} -- so walk() below can switch to
// that nested call's own module/function when descending into its args,
// the same context-tracking pattern postgres-call-args.ts's own walk()
// uses for AccountId32/byte-blob decoding.
function isReconstructedCall(value: unknown): value is ReconstructedCall {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).call_module === "string" &&
    typeof (value as Record<string, unknown>).call_function === "string" &&
    "call_args" in value,
  );
}

interface TypedFieldDescriptor {
  name: string;
  type: string;
  value: unknown;
}

// True for a typed field descriptor ({name, type, value}) -- the shape
// EVERY extrinsic's own top-level call_args is genuinely served as
// (confirmed live 2026-07-12; D1's `[{name,type,value}]` shape was never
// D1-only -- see src/indexer-rs-ethereum-decode.ts's header for the same
// correction). A nested call's own call_args, by contrast, arrives as a
// flat {fieldName: value} object with no per-field type string (confirmed
// live: a nested claim_root's call_args is `{"subnets": ...}`, not an array
// of descriptors) -- walk() below handles both shapes, since the field name
// that matters for the BTREESET_FIELDS lookup is the descriptor's own
// `.name` in one case and the plain object key in the other.
function isTypedFieldDescriptor(value: unknown): value is TypedFieldDescriptor {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).name === "string" &&
    typeof (value as Record<string, unknown>).type === "string" &&
    Object.keys(value).length === 3 &&
    "value" in value,
  );
}

interface CallContext {
  call_module: string;
  call_function: string;
}

function walk(value: unknown, call: CallContext | null): unknown {
  if (isReconstructedCall(value)) {
    return {
      ...value,
      call_args: walk(value.call_args, {
        call_module: value.call_module,
        call_function: value.call_function,
      }),
    };
  }
  if (isTypedFieldDescriptor(value)) {
    let inner = walk(value.value, call);
    if (
      call &&
      BTREESET_FIELDS.has(
        `${call.call_module}.${call.call_function}.${value.name}`,
      )
    ) {
      inner = unwrapBTreeSetLayer(inner);
    }
    return { ...value, value: inner };
  }
  if (Array.isArray(value)) return value.map((item) => walk(item, call));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      let processed = walk(val, call);
      if (
        call &&
        BTREESET_FIELDS.has(`${call.call_module}.${call.call_function}.${key}`)
      ) {
        processed = unwrapBTreeSetLayer(processed);
      }
      out[key] = processed;
    }
    return out;
  }
  return value;
}

/** Unwraps BTreeSet-typed fields in callArgs for the small set of
 * (callModule, callFunction, fieldName) triples confirmed to need it, at any
 * nesting depth (a top-level field, or one inside a reconstructed nested
 * RuntimeCall -- e.g. Utility.batch wrapping SubtensorModule.claim_root). A
 * no-op (returns callArgs unchanged, or with only the confirmed fields
 * touched) for every other call -- safe to apply unconditionally in
 * formatExtrinsic regardless of which tier produced the row, same contract
 * as normalizePostgresValue (#4690) and decodePostgresCallArgs (#4691). */
export function decodeBTreeSetFields(
  callModule: unknown,
  callFunction: unknown,
  callArgs: unknown,
): unknown {
  return walk(callArgs, {
    call_module: String(callModule),
    call_function: String(callFunction),
  });
}
