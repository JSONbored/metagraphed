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
// src/extrinsics.mjs formatExtrinsic's `JSON.parse(row.call_args)` call --
// the same JSON.parse used for BOTH D1 and Postgres rows. So "reproduce D1's
// behavior" and "the bug this repo already accepts for
// SubtensorModule.register's PoW nonce" are the same underlying JS
// large-integer/JSON.parse issue, not something unique to the EVM fields.
//
// Given Postgres hands us the 4 raw little-endian u64 limbs with NO
// precision lost yet, and real production data already has `value` (wei)
// fields exceeding Number.MAX_SAFE_INTEGER for perfectly ordinary transfers
// (confirmed: 0.02-1.5 ETH = 2e16-1.5e18 wei, all past 9007199254740991) --
// this is the normal case for any non-trivial transfer, not a remote edge
// case at 2^256 -- this decoder DIVERGES from reproducing that precision
// loss: U256 fields decode to an EXACT decimal STRING via BigInt, matching
// how ethers.js/web3.js/viem represent U256 (never a plain JS number, for
// exactly this reason). This is a real type divergence from D1's current
// (already-lossy) plain-number shape even for small values that fit safely
// -- a deliberate, documented choice per Requirement 2, not an oversight.
import { isEnumTreeNode } from "./scale-normalize.mjs";
import { unwrapByteArray, bytesToHex } from "./bytes.mjs";

// Peels indexer-rs's one newtype-wrap layer around a U256's 4-limb
// little-endian u64 array ([[limb0,limb1,limb2,limb3]]). Limbs are u64
// values (up to 2^64-1), so this can't reuse bytes.mjs's unwrapByteArray --
// that caps individual elements at 0-255 for a genuine byte blob.
function unwrapU256Limbs(value) {
  if (!Array.isArray(value) || value.length !== 1 || !Array.isArray(value[0])) {
    return null;
  }
  const limbs = value[0];
  if (limbs.length !== 4) return null;
  return limbs.every(
    (n) => typeof n === "number" && Number.isInteger(n) && n >= 0,
  )
    ? limbs
    : null;
}

/** 4-limb little-endian u64 array -> exact decimal string (see module header
 * for why this is a string, not a JS number). Returns `value` unchanged
 * (no-op) when the shape doesn't match -- safe on D1's own already-decoded
 * plain-number fields, since a JS number is never a 1-element array. */
export function decodeU256Limbs(value) {
  const limbs = unwrapU256Limbs(value);
  if (!limbs) return value;
  const [l0, l1, l2, l3] = limbs.map(BigInt);
  return (l0 + (l1 << 64n) + (l2 << 128n) + (l3 << 192n)).toString();
}

/** 20-byte array (H160), newtype-wrapped or flat -- lowercase 0x-prefixed
 * hex, matching D1's address string form. Reuses bytes.mjs's depth-agnostic
 * unwrapByteArray (already length-agnostic; H160 is just a 20-byte case of
 * the same generic byte-blob shape #4689 already handles). Returns `value`
 * unchanged when the shape doesn't match. */
export function decodeH160Bytes(value) {
  const bytes = unwrapByteArray(value);
  return bytes && bytes.length === 20 ? bytesToHex(bytes) : value;
}

// A 32-byte hash-like value (Ethereum's ECDSA signature r/s components) --
// same generic byte-blob-to-hex treatment, just gated on length 32 instead
// of 20. Not exported: only meaningful composed inside decodeEip1559Payload
// below, unlike decodeH160Bytes which Requirement 3 names as its own
// reusable unit.
function decodeHash32Bytes(value) {
  const bytes = unwrapByteArray(value);
  return bytes && bytes.length === 32 ? bytesToHex(bytes) : value;
}

/** Rust single-field tuple-variant enum ({name, values:[x]}) -> D1's
 * single-key shorthand ({[name]: decodePayload(x)}). A no-op passthrough
 * (returns `value` unchanged) when the shape doesn't match -- safe on D1's
 * own {Name: value} shape or a plain scalar. */
function decodeTupleVariantEnum(value, decodePayload) {
  if (!isEnumTreeNode(value) || value.values.length !== 1) return value;
  return { [value.name]: decodePayload(value.values[0]) };
}

const U256_FIELDS = [
  "nonce",
  "value",
  "gas_limit",
  "max_fee_per_gas",
  "max_priority_fee_per_gas",
];

// Ethereum.transact's `transaction` field's inner EIP1559 struct: the 5 U256
// fields above, `action` (a nested TransactionAction::Call tuple-variant
// wrapping an H160), and `signature.r`/`signature.s` (32-byte hash-like
// values, NOT wrapped in an enum -- EIP1559's own ECDSA signature is a plain
// struct, unrelated to the Signature::Sr25519 enum family below).
// `chain_id`/`odd_y_parity`/`access_list` need no decode (already plain
// scalars/empty arrays either tier). `input` is deliberately left untouched
// -- its own mojibake bug is D1's, out of scope here (bytes.mjs's own header).
function decodeEip1559Payload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  const out = { ...payload };
  for (const field of U256_FIELDS) {
    if (field in out) out[field] = decodeU256Limbs(out[field]);
  }
  if ("action" in out) {
    out.action = decodeTupleVariantEnum(out.action, decodeH160Bytes);
  }
  if (out.signature && typeof out.signature === "object") {
    out.signature = {
      ...out.signature,
      r: decodeHash32Bytes(out.signature.r),
      s: decodeHash32Bytes(out.signature.s),
    };
  }
  return out;
}

/** Ethereum.transact's call_args: decodes the `transaction` field's nested
 * EIP1559 payload (U256s, action's H160, signature's hash bytes) into D1's
 * `{transaction: {EIP1559: {...}}}` shape. No-op (returns callArgs
 * unchanged) when `transaction` isn't Postgres's enum-tree shape -- D1's own
 * `[{name,type,value}]` descriptor array has no `.transaction` property at
 * all (arrays don't have named keys), so this never fires on a D1 row. */
export function decodeEthereumTransactArgs(callArgs) {
  if (!callArgs || typeof callArgs !== "object" || Array.isArray(callArgs)) {
    return callArgs;
  }
  const tx = callArgs.transaction;
  if (!isEnumTreeNode(tx) || tx.values.length !== 1) return callArgs;
  return {
    ...callArgs,
    transaction: decodeTupleVariantEnum(tx, decodeEip1559Payload),
  };
}

/** EVM.withdraw's call_args: decodes `address` (H160) to hex. Same D1
 * no-op guarantee as above (a D1 descriptor array has no `.address` key). */
export function decodeEvmWithdrawArgs(callArgs) {
  if (!callArgs || typeof callArgs !== "object" || Array.isArray(callArgs)) {
    return callArgs;
  }
  if (!("address" in callArgs)) return callArgs;
  return { ...callArgs, address: decodeH160Bytes(callArgs.address) };
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
function decodeSr25519SignatureValue(value) {
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

// Recursively finds every key literally named "signature" and decodes it if
// (and only if) its value matches the Sr25519 shape above -- scoped to
// LimitOrders.execute_batched_orders/Drand.write_pulse specifically (via the
// dispatch table below), not applied to every call's args. A plain
// recursive walk rather than a fixed-depth lookup because the two calls
// place `signature` at different depths: Drand.write_pulse has it as a
// direct top-level field, LimitOrders.execute_batched_orders has it nested
// inside each entry of its (Vec-wrapped) `orders` array -- both confirmed
// against real production data.
function walkForSignatureFields(value) {
  if (Array.isArray(value)) return value.map(walkForSignatureFields);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] =
        key === "signature"
          ? decodeSr25519SignatureValue(val)
          : walkForSignatureFields(val);
    }
    return out;
  }
  return value;
}

/** LimitOrders.execute_batched_orders / Drand.write_pulse call_args: decodes
 * any `signature` field matching the Sr25519 shape, at whatever depth it
 * occurs. A no-op on D1's own already-decoded {"Sr25519": "0x..."} shape
 * (isEnumTreeNode requires a "values" array key, which a single-key shorthand
 * object doesn't have). */
export function decodeSignatureFieldArgs(callArgs) {
  return walkForSignatureFields(callArgs);
}

const DECODERS = {
  "Ethereum.transact": decodeEthereumTransactArgs,
  "EVM.withdraw": decodeEvmWithdrawArgs,
  "LimitOrders.execute_batched_orders": decodeSignatureFieldArgs,
  "Drand.write_pulse": decodeSignatureFieldArgs,
};

/** Dispatches to the right decoder for (callModule, callFunction), or
 * returns callArgs unchanged for every other call type -- safe to apply
 * unconditionally in formatExtrinsic regardless of which tier produced the
 * row or what call it decoded, same contract as normalizePostgresValue
 * (#4690) and decodePostgresCallArgs (#4691). */
export function decodeEthereumEvmCallArgs(callModule, callFunction, callArgs) {
  const decoder = DECODERS[`${callModule}.${callFunction}`];
  return decoder ? decoder(callArgs) : callArgs;
}
