// Server-side decoders for indexer-rs's (Postgres) Ethereum/EVM pallet
// shapes and the third-party pallets sharing its tuple-variant enum
// convention -- Ethereum.transact's U256/H160/EIP1559 fields, EVM.withdraw's
// H160 address, and the Signature::Sr25519 payload shared by
// LimitOrders.execute_batched_orders and Drand.write_pulse (#4692).
//
// Scoped to these SPECIFIC (call_module, call_function) pairs and named
// fields -- never a generic "any 4-limb array is a U256" or "any bytes
// field is an address" heuristic, since neither shape has been confirmed
// unique across the schema (a Vec<u64> or an AccountId32 could coincidentally
// look similar). MevShield was named as a *probable* third Signature::Sr25519
// user in the original research, but verifying against real production data
// (block 8543969/7 submit_encrypted, block 8543971/1 announce_next_key)
// shows neither function has a signature field at all --
// submit_encrypted's sole arg is a raw ciphertext byte blob, announce_next_key's
// is an Option-wrapped encryption public key -- so MevShield is deliberately
// NOT in the dispatch table below.
//
// ## The U256 precision decision (#4692 Requirement 2)
//
// D1's `nonce`/`value`/`gas_limit`/`max_fee_per_gas`/`max_priority_fee_per_gas`
// are already known to lose precision for large values -- but tracing
// scripts/fetch-events.py shows this is NOT a D1-specific behavior to
// reconcile: fetch-events.py writes the exact Python int via json.dumps
// (lossless at the storage layer; no str()/precision handling anywhere in
// that file), and the actual corruption happens in the SHARED
// src/extrinsics.ts formatExtrinsic's `JSON.parse(row.call_args)` call --
// the same JSON.parse used for BOTH D1 and Postgres rows. So "reproduce D1's
// behavior" and "the bug this repo already accepts for
// SubtensorModule.register's PoW nonce" are the same underlying JS
// large-integer/JSON.parse issue, not something unique to the EVM fields.
//
// Given real production data already has `value` (wei) fields exceeding
// Number.MAX_SAFE_INTEGER for perfectly ordinary transfers (confirmed:
// 0.02-1.5 ETH = 2e16-1.5e18 wei, all past 9007199254740991) -- the normal
// case for any non-trivial transfer, not a remote edge case at 2^256 -- this
// decoder DIVERGES from reproducing that precision loss: U256 fields decode
// to an EXACT decimal STRING via BigInt, matching how ethers.js/web3.js/viem
// represent U256 (never a plain JS number, for exactly this reason).
//
// IMPORTANT: this decision is only real if the limbs Postgres hands over
// actually survive intact to this point. A first version of this module
// (caught by Gittensory review on the original #4692 PR) reconstructed the
// BigInt correctly but from an ALREADY-corrupted input: src/extrinsics.ts's
// formatExtrinsic ran plain `JSON.parse(row.call_args)` before this decoder
// ever ran, and standard JSON.parse silently rounds any bare integer literal
// past 2^53 the exact same way -- so a limb like 9131459485341369597 arrived
// here already rounded to 9131459485341369344, and the resulting decimal
// string LOOKED exact while being built from imprecise input. Fixed by
// routing row.call_args through src/big-int-safe-json.ts's
// parseJsonPreservingBigInts instead of bare JSON.parse -- see that module's
// header for the mechanism. toLimbBigInt below accepts either a plain number
// (the common case: 3 of a U256's 4 limbs are usually 0, safe either way) or
// the numeric STRING that parser produces for a limb large enough to need it.
import { isEnumTreeNode } from "./scale-normalize.ts";
import { unwrapByteArray, bytesToHex } from "./bytes.ts";
import { decodeEvmPrecompileCall } from "./evm-precompiles.ts";

// A single limb (u64, up to 2^64-1) as delivered by src/extrinsics.ts's
// parseJsonPreservingBigInts (#4692 review fix): most limbs are small enough
// to survive plain JSON.parse as a JS number (the common case -- 3 of a
// U256's 4 limbs are usually 0), but a limb large enough to lose precision
// under standard JSON.parse arrives pre-quoted as an exact numeric STRING
// instead. Accepts either; returns null for anything else (so a genuinely
// malformed/negative/fractional limb correctly fails unwrapU256Limbs rather
// than silently coercing).
function toLimbBigInt(limb: unknown): bigint | null {
  if (typeof limb === "number") {
    return Number.isInteger(limb) && limb >= 0 ? BigInt(limb) : null;
  }
  if (typeof limb === "string") {
    return /^\d+$/.test(limb) ? BigInt(limb) : null;
  }
  return null;
}

// Peels indexer-rs's one newtype-wrap layer around a U256's 4-limb
// little-endian u64 array ([[limb0,limb1,limb2,limb3]]). Limbs are u64
// values (up to 2^64-1), so this can't reuse bytes.mjs's unwrapByteArray --
// that caps individual elements at 0-255 for a genuine byte blob.
function unwrapU256Limbs(value: unknown): bigint[] | null {
  if (!Array.isArray(value) || value.length !== 1 || !Array.isArray(value[0])) {
    return null;
  }
  const limbs = value[0];
  if (limbs.length !== 4) return null;
  const bigLimbs = limbs.map(toLimbBigInt);
  return bigLimbs.every((b): b is bigint => b !== null) ? bigLimbs : null;
}

/** 4-limb little-endian u64 array -> exact decimal string (see module header
 * for why this is a string, not a JS number). Returns `value` unchanged
 * (no-op) when the shape doesn't match -- safe on D1's own already-decoded
 * plain-number fields, since a JS number is never a 1-element array. */
export function decodeU256Limbs(value: unknown): unknown {
  const limbs = unwrapU256Limbs(value);
  if (!limbs) return value;
  const [l0, l1, l2, l3] = limbs;
  return (l0 + (l1 << 64n) + (l2 << 128n) + (l3 << 192n)).toString();
}

/** 20-byte array (H160), newtype-wrapped or flat -- lowercase 0x-prefixed
 * hex, matching D1's address string form. Reuses bytes.mjs's depth-agnostic
 * unwrapByteArray (already length-agnostic; H160 is just a 20-byte case of
 * the same generic byte-blob shape #4689 already handles). Returns `value`
 * unchanged when the shape doesn't match. */
export function decodeH160Bytes(value: unknown): unknown {
  const bytes = unwrapByteArray(value);
  return bytes && bytes.length === 20 ? bytesToHex(bytes) : value;
}

// A 32-byte hash-like value (Ethereum's ECDSA signature r/s components) --
// same generic byte-blob-to-hex treatment, just gated on length 32 instead
// of 20. Not exported: only meaningful composed inside decodeEthereumTransactionPayload
// below, unlike decodeH160Bytes which Requirement 3 names as its own
// reusable unit.
function decodeHash32Bytes(value: unknown): unknown {
  const bytes = unwrapByteArray(value);
  return bytes && bytes.length === 32 ? bytesToHex(bytes) : value;
}

/** Rust single-field tuple-variant enum ({name, values:[x]}) -> D1's
 * single-key shorthand ({[name]: decodePayload(x)}). A no-op passthrough
 * (returns `value` unchanged) when the shape doesn't match -- safe on D1's
 * own {Name: value} shape or a plain scalar. */
function decodeTupleVariantEnum(
  value: unknown,
  decodePayload: (payload: unknown) => unknown,
): unknown {
  if (!isEnumTreeNode(value) || value.values.length !== 1) return value;
  return { [value.name]: decodePayload(value.values[0]) };
}

const U256_FIELDS = [
  "nonce",
  "value",
  "gas_limit",
  "max_fee_per_gas",
  "max_priority_fee_per_gas",
  // Added 2026-07-12, found live-verifying #4933: TransactionV3::Legacy
  // (confirmed live alongside EIP1559 -- both are the only two variants
  // observed so far) uses a single `gas_price` U256 instead of the dual
  // max_fee_per_gas/max_priority_fee_per_gas fee-market fields -- it stayed
  // raw because it wasn't in this list, the same shape gap as every other
  // field here, just missed because the initial fix's fixture happened to
  // be an EIP1559 transaction.
  "gas_price",
];

// Ethereum.transact's `transaction` field's inner payload struct (shared by
// every TransactionV3 variant -- EIP1559 and Legacy confirmed live): the
// U256 fields above, `action` (a nested TransactionAction::Call tuple-variant
// wrapping an H160), and `signature.r`/`signature.s` (32-byte hash-like
// values, NOT wrapped in an enum -- the ECDSA signature is a plain struct,
// unrelated to the Signature::Sr25519 enum family below). `chain_id`/
// `odd_y_parity`/`access_list`/Legacy's `signature.v` need no decode
// (already plain scalars/empty arrays either tier). `input` itself is
// deliberately left untouched -- its own mojibake bug is D1's, out of scope
// here (bytes.mjs's own header) -- `precompile_call` below is an ADDITIVE
// field decoded from it, not a rewrite of it.
function decodeEthereumTransactionPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  const out: Record<string, unknown> = {
    ...(payload as Record<string, unknown>),
  };
  for (const field of U256_FIELDS) {
    if (field in out) out[field] = decodeU256Limbs(out[field]);
  }
  if ("action" in out) {
    out.action = decodeTupleVariantEnum(out.action, decodeH160Bytes);
  }
  if (out.signature && typeof out.signature === "object") {
    const signature = out.signature as Record<string, unknown>;
    out.signature = {
      ...signature,
      r: decodeHash32Bytes(signature.r),
      s: decodeHash32Bytes(signature.s),
    };
  }
  // Precompile call decode (#6725/#6727): only possible for a Call action --
  // a Create transaction has no `to`, so the concept doesn't apply. Always
  // set (never conditionally omitted), same schema-stable-null contract as
  // every other build* function here: null for a Create action, a non-
  // precompile `to`, or calldata too short to carry a 4-byte selector.
  const to =
    out.action && typeof out.action === "object"
      ? (out.action as Record<string, unknown>).Call
      : undefined;
  const inputBytes = unwrapByteArray(out.input);
  out.precompile_call =
    typeof to === "string" && inputBytes
      ? decodeEvmPrecompileCall(to, bytesToHex(inputBytes))
      : null;
  return out;
}

// #4692's original design assumed call_args reaches this point as a flat
// {fieldName: value} object -- D1's shape was documented as the ONLY
// exception, an array of {name,type,value} descriptors with "no .transaction
// property at all (arrays don't have named keys)". That assumption was
// wrong: confirmed live 2026-07-12, EVERY extrinsic's call_args -- D1 is
// fully retired (#4772), so this is genuine indexer-rs/Postgres output, not
// a legacy D1 artifact -- is served as this exact descriptor-array shape
// (e.g. Ethereum.transact's sole argument arrives as
// `[{name:"transaction",type:"TransactionV3",value:{...}}]`), which is WHY
// every decoder below was silently a 100% no-op in production despite being
// individually well-tested against hand-constructed flat-object fixtures.
// decodePostgresCallArgs (walk(), src/postgres-call-args.ts) already
// decodes AccountId32/byte-blob fields INSIDE each descriptor's `.value`
// without flattening the outer array -- by design, since the descriptor
// array is the real, final served shape for every call type, not something
// meant to be unwrapped away. findCallArg/withCallArg below locate and
// replace a named argument within that array (or, defensively, a flat
// object, since nothing else in this file distinguishes the two and a past
// design intended to support both).
function findCallArg(callArgs: unknown, fieldName: string): unknown {
  if (Array.isArray(callArgs)) {
    const descriptor = callArgs.find(
      (d) => d && typeof d === "object" && d.name === fieldName,
    );
    return descriptor ? descriptor.value : undefined;
  }
  if (callArgs && typeof callArgs === "object") {
    return (callArgs as Record<string, unknown>)[fieldName];
  }
  return undefined;
}

// Only ever called after findCallArg has already returned a defined value
// for the same (callArgs, fieldName) pair, which requires callArgs to
// already be an array or an object (see findCallArg above) -- no third
// fallback needed.
function withCallArg(
  callArgs: unknown,
  fieldName: string,
  newValue: unknown,
): unknown {
  if (Array.isArray(callArgs)) {
    return callArgs.map((d) =>
      d && typeof d === "object" && d.name === fieldName
        ? { ...d, value: newValue }
        : d,
    );
  }
  return { ...(callArgs as Record<string, unknown>), [fieldName]: newValue };
}

/** Ethereum.transact's call_args: decodes the `transaction` field's nested
 * EIP1559 payload (U256s, action's H160, signature's hash bytes). Returns
 * callArgs unchanged (same shape, `transaction` untouched) when the field
 * isn't found or isn't Postgres's enum-tree shape. */
export function decodeEthereumTransactArgs(callArgs: unknown): unknown {
  const tx = findCallArg(callArgs, "transaction");
  if (!isEnumTreeNode(tx) || tx.values.length !== 1) return callArgs;
  return withCallArg(
    callArgs,
    "transaction",
    decodeTupleVariantEnum(tx, decodeEthereumTransactionPayload),
  );
}

/** EVM.withdraw's call_args: decodes `address` (H160) to hex. Returns
 * callArgs unchanged when the field isn't found. */
export function decodeEvmWithdrawArgs(callArgs: unknown): unknown {
  const address = findCallArg(callArgs, "address");
  if (address === undefined) return callArgs;
  return withCallArg(callArgs, "address", decodeH160Bytes(address));
}

/** DynamicFee.note_min_gas_price_target's call_args: decodes `target` (U256,
 * the same 4-limb little-endian encoding as Ethereum.transact's nonce/value/
 * gas_limit) to an exact decimal string. Returns callArgs unchanged when the
 * field isn't found. Found live 2026-07-12: this call type wasn't in
 * DECODERS at all, so `target` fell into the generic non-collection
 * byte-blob branch elsewhere in the pipeline (postgres-call-args.ts),
 * which misinterprets the 4 raw u64 limbs as individual bytes and
 * hex-encodes them directly -- silently WRONG (not just undecoded) whenever
 * a limb is small enough to look like a valid byte value, e.g. limbs
 * [1,0,0,0] (the real target value 1) rendered as hex "0x01000000"
 * (16,777,216) instead of decimal "1". */
export function decodeDynamicFeeArgs(callArgs: unknown): unknown {
  const target = findCallArg(callArgs, "target");
  if (target === undefined) return callArgs;
  return withCallArg(callArgs, "target", decodeU256Limbs(target));
}

// {name:"Sr25519", values:[bytes]} -> {Sr25519: "0x..."}. Gated on the
// variant name specifically (not "any tuple-variant enum found under a key
// named signature") since MultiSignature has other variants (Ed25519,
// Ecdsa) not evidenced in this repo's data yet -- declines rather than
// guessing their payload shape. #4690's Option<T> pass already strips any
// Some(...) wrapper before this runs (confirmed against real
// Drand.write_pulse data: signature arrives as {name:"Some",
// values:[{name:"Sr25519",...}]} pre-normalize, bare {name:"Sr25519",...}
// after), so this only needs to handle the bare variant.
function decodeSr25519SignatureValue(value: unknown): unknown {
  if (
    !isEnumTreeNode(value) ||
    value.name !== "Sr25519" ||
    value.values.length !== 1
  ) {
    return value;
  }
  const bytes = unwrapByteArray(value.values[0]);
  return bytes ? { Sr25519: bytesToHex(bytes) } : value;
}

// A "signature"/"randomness"-named field that ISN'T enum-wrapped -- confirmed
// live 2026-07-12: Drand.write_pulse's per-pulse `signature`/`randomness`
// (round-based VRF output, not a MultiSignature) are bare 32-byte newtype-
// wrapped arrays, unlike LimitOrders.execute_batched_orders' per-order
// `signature`, which genuinely IS a Signature::Sr25519 enum variant. Tries
// the enum shape first so LimitOrders keeps its richer {Sr25519:"0x..."}
// output; falls back to plain hex (the same generic hash-like treatment
// decodeHash32Bytes already gives EIP1559's r/s) when the enum shape doesn't
// match, rather than leaving a bare hash-like field raw.
function decodeSignatureLikeField(value: unknown): unknown {
  const enumDecoded = decodeSr25519SignatureValue(value);
  if (enumDecoded !== value) return enumDecoded;
  // Fallback for a bare (non-enum-wrapped) hash-like byte array. Length-
  // agnostic, unlike decodeHash32Bytes's other uses in this file (EIP1559's
  // signature.r/s, always exactly 32 bytes for ECDSA) -- confirmed live
  // 2026-07-12: Drand.write_pulse's per-pulse `signature` is a 48-byte
  // BLS12-381 G1 point (its `randomness` sibling happens to be 32 bytes, so
  // it coincidentally passed decodeHash32Bytes's strict length check while
  // `signature` silently stayed raw). This function is only ever reached for
  // a field literally named "signature"/"randomness" within the narrow
  // Drand/LimitOrders call types this module dispatches to, so any byte-blob
  // shape here is safe to hex-encode regardless of exact length.
  const bytes = unwrapByteArray(value);
  return bytes && bytes.length > 0 ? bytesToHex(bytes) : value;
}

interface TypedFieldDescriptor {
  name: string;
  type: string;
  value: unknown;
}

// Recursively finds every key literally named "signature"/"randomness"
// (decodeSignatureLikeField -- enum-wrapped or bare 32 bytes, either way) or
// "public" (decodeSr25519SignatureValue -- Drand.write_pulse's
// MultiSigner::Sr25519 pubkey, the same enum shape as a Signature::Sr25519
// payload) -- scoped to LimitOrders.execute_batched_orders/Drand.write_pulse
// specifically (via the dispatch table below), not applied to every call's
// args. A plain recursive walk rather than a fixed-depth lookup because the
// two calls place these fields at different depths: Drand.write_pulse has
// `public`/`pulses[].signature`/`pulses[].randomness`, LimitOrders.
// execute_batched_orders has `signature` nested inside each entry of its
// (Vec-wrapped) `orders` array -- all confirmed against real production
// data.
// True for D1/indexer-rs's typed call_args field descriptor {name,type,value}
// (duplicated 3-line shape check, matching this codebase's own established
// pattern of not cross-importing such a check between sibling decode modules
// -- see postgres-call-args.ts's identical isTypedFieldDescriptor and its
// header comment for the rationale).
function isTypedFieldDescriptor(value: unknown): value is TypedFieldDescriptor {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 3 &&
    typeof (value as Record<string, unknown>).name === "string" &&
    typeof (value as Record<string, unknown>).type === "string" &&
    "value" in value,
  );
}

function walkForSignatureFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(walkForSignatureFields);
  if (value && typeof value === "object") {
    // A typed-descriptor node carries its field name as the VALUE of its own
    // "name" property, not as a literal object key the generic loop below
    // can match against "signature"/"randomness"/"public" -- confirmed live
    // 2026-07-12: Drand.write_pulse's TOP-LEVEL `signature`
    // (Option<MultiSignature>, arrives as {name:"signature",
    // type:"Option<MultiSignature>", value:{...}}) stayed completely raw
    // because this function only ever recursed generically into `.value`,
    // never recognizing the descriptor itself as the signature field (unlike
    // the per-pulse `signature`/`randomness`/`public` fields nested deeper,
    // which arrive as genuine struct fields with real object keys and
    // already matched correctly).
    if (isTypedFieldDescriptor(value)) {
      if (value.name === "signature" || value.name === "randomness") {
        return { ...value, value: decodeSignatureLikeField(value.value) };
      }
      if (value.name === "public") {
        return { ...value, value: decodeSr25519SignatureValue(value.value) };
      }
      return { ...value, value: walkForSignatureFields(value.value) };
    }
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      if (key === "signature" || key === "randomness") {
        out[key] = decodeSignatureLikeField(val);
      } else if (key === "public") {
        out[key] = decodeSr25519SignatureValue(val);
      } else {
        out[key] = walkForSignatureFields(val);
      }
    }
    return out;
  }
  return value;
}

/** LimitOrders.execute_batched_orders / Drand.write_pulse call_args: decodes
 * every `signature`/`randomness`/`public` field matching the shapes above, at
 * whatever depth they occur. A no-op on an already-decoded shape (a bare hex
 * string or a single-key `{Sr25519: "..."}` shorthand doesn't match either
 * decoder's own shape check). */
export function decodeSignatureFieldArgs(callArgs: unknown): unknown {
  return walkForSignatureFields(callArgs);
}

const DECODERS: Record<string, (callArgs: unknown) => unknown> = {
  "Ethereum.transact": decodeEthereumTransactArgs,
  "EVM.withdraw": decodeEvmWithdrawArgs,
  "LimitOrders.execute_batched_orders": decodeSignatureFieldArgs,
  "Drand.write_pulse": decodeSignatureFieldArgs,
  "DynamicFee.note_min_gas_price_target": decodeDynamicFeeArgs,
};

/** Dispatches to the right decoder for (callModule, callFunction), or
 * returns callArgs unchanged for every other call type -- safe to apply
 * unconditionally in formatExtrinsic regardless of which tier produced the
 * row or what call it decoded, same contract as normalizePostgresValue
 * (#4690) and decodePostgresCallArgs (#4691). */
export function decodeEthereumEvmCallArgs(
  callModule: unknown,
  callFunction: unknown,
  callArgs: unknown,
): unknown {
  const decoder = DECODERS[`${callModule}.${callFunction}`];
  return decoder ? decoder(callArgs) : callArgs;
}
