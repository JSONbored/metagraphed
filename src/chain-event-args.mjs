// Server-side port of apps/ui/src/lib/metagraphed/chain-event-args.ts (#3984,
// PR #4621) -- that fix decoded chain-event args client-side, but only inside
// apps/ui/src/routes/blocks.$ref.tsx. Every other consumer of the same
// chain_events.args column (the REST /api/v1/chain-events routes and the
// list_chain_events/get_block_chain_events/get_extrinsic_chain_events MCP
// tools, all served unconditionally with no D1 fallback) still got the raw
// shape. This decodes once, server-side, so every consumer sees the same
// human-readable values (#4685).
//
// chain-event args arrive as decoded SCALE values, where account ids and
// Ethereum addresses are raw fixed-length number arrays (indexer-rs's
// generic dynamic-value dump wraps a tuple-struct-with-one-field like
// AccountId32([u8;32])/H160([u8;20]) in an extra array layer --
// [[b0..b31]], not a flat byte array). Rendered verbatim they read like
// `{"who":[[109,111,100,101,...]]}` -- unreadable and unbounded. This walks
// the value and rewrites 32-byte arrays into a human-readable form: an SS58
// address when the field name marks it as an account, otherwise a 0x-hex
// string (so a 32-byte hash isn't mislabelled as an address, and an
// untagged positional arg with no key hint -- e.g. a non-System/Balances
// pallet event's args tuple -- always falls to hex rather than guessing).
// 20-byte arrays always hex-decode as H160 (Ethereum addresses have no SS58
// form). A narrow, explicit pallet.method.field allowlist additionally
// UTF-8-decodes the handful of known free-text byte fields (e.g. Ethereum.
// Executed's extra_data), hex-decodes a few known opaque byte-blob fields
// (e.g. EVM.Log's log data) regardless of length, and collapses a handful of
// known {name,values} enum-tag nodes once their payload is fully decoded
// (e.g. a MultiAddress::Signed(AccountId32) tag once the account itself is
// hex, or a Result<(),E>::Ok(()) down to bare "Ok"). Everything else is
// untouched.
import { encodeAccountId32 } from "./ss58.ts";

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
  // Added 2026-07-12 from a live sweep of every chain_events.args pallet.method
  // combination: real/proxy/delegatee/delegator (Proxy.RealPaysFeeSet/
  // Announced/ProxyAdded/ProxyRemoved) and new_hotkey/old_hotkey
  // (SubtensorModule.HotkeySwappedOnSubnet) are all confirmed-live 32-byte
  // AccountId32 fields that stayed raw hex only because their exact key name
  // wasn't in this set yet -- same root cause/fix shape as the original
  // allowlist, not a new mechanism.
  "real",
  "proxy",
  "delegatee",
  "delegator",
  "new_hotkey",
  "old_hotkey",
  // Added 2026-07-12 from a full 150-item ground-truth audit against live
  // served output (all 82 chain_events + 68 extrinsics pallet.method/
  // module.function combinations): multisig/approving (Multisig.NewMultisig/
  // MultisigApproval/MultisigExecuted) and sender (System.Remarked) are all
  // confirmed-live 32-byte AccountId32 fields missed by the prior sweep.
  // "caller" (Contracts.Called) is the account payload of a
  // MultiAddress::Signed(AccountId32) unwrapped via ENUM_PAYLOAD_FIELDS below
  // -- must be here too, since the unwrapped payload is decoded with THIS
  // key's own hint, not a synthetic one.
  "multisig",
  "approving",
  "sender",
  "caller",
  // Added from a follow-up live sweep (2026-07-12): contract (Contracts.
  // ContractEmitted/Called) and signer (LimitOrders.OrderExecuted) are
  // confirmed-live 32-byte AccountId32 fields, cross-checked against a
  // sibling field with the identical raw bytes correctly SS58-encoded in
  // the same block (Contracts.Called's own "caller", and
  // LimitOrders.execute_batched_orders' explicitly-typed nested "signer").
  "contract",
  "signer",
  // Added 2026-07-14 (#5359/#61), two distinct gaps found while building
  // POSITIONAL_FIELD_NAMES below:
  // (1) ColdkeySwapped's args ARRIVE as a named object ({"new_coldkey":...,
  //     "old_coldkey":...}, confirmed live) but stayed raw hex anyway --
  //     the exact key names were simply never added here, same root cause
  //     as the 2026-07-12 new_hotkey/old_hotkey gap this set already fixed,
  //     just the coldkey-swap counterpart the original sweep missed.
  // (2) origin_coldkey/destination_coldkey (StakeTransferred) and
  //     destination_hotkey (StakeMoved) are synthetic names this file
  //     assigns via POSITIONAL_FIELD_NAMES below to positions confirmed
  //     live to be 32-byte AccountId32 values with no name of their own
  //     (StakeTransferred/StakeMoved's args arrive as bare unnamed tuples).
  "new_coldkey",
  "old_coldkey",
  "origin_coldkey",
  "destination_coldkey",
  "destination_hotkey",
]);

// Confirmed positional field orders for events whose args arrive as an
// UNNAMED tuple (a bare JSON array, no key at any depth -- confirmed live
// 2026-07-14 for every entry below except TakeIncreased/TakeDecreased/
// CRV3WeightsRevealed, which have zero rows in the currently-indexed
// chain_events range to sample directly; those three are included on
// strong structural grounds instead -- apps/indexer-rs's own extract()
// match arms explicitly group TakeIncreased/TakeDecreased with the
// confirmed-live-positional DelegateAdded under one "_take_changed" shape
// comment, and CRV3WeightsRevealed's own comment ("NOTE netuid-first,
// reverse of *Committed") describes the exact shape independently
// confirmed live for its newer sibling TimelockedWeightsRevealed).
//
// Sourced from apps/indexer-rs/src/main.rs's extract() (the account_events
// curator, which reads these same fields by position off the identical
// decoded Value shape) cross-checked against a live chain_events.args
// sample per event kind (metagraphed#5347's investigation tooling: DUMP_
// METADATA-style live decode + a direct Postgres sample query, both
// 2026-07-14). Deliberately partial: an event's real field count sometimes
// exceeds what indexer-rs itself curates (e.g. StakeAdded/StakeRemoved
// carry a confirmed-live 6th positional field indexer-rs never reads) --
// every name here is either a real account (needed for the SS58-vs-hex
// decision this whole file exists for) or copied straight from an
// extract() doc comment; an unmapped trailing position falls through to
// the existing generic decode exactly like today, rather than guess a name
// for a field this codebase hasn't verified.
const POSITIONAL_FIELD_NAMES = new Map([
  ["SubtensorModule.NeuronRegistered", ["netuid", "uid", "hotkey"]],
  [
    "SubtensorModule.StakeAdded",
    ["coldkey", "hotkey", "amount_tao", "alpha_amount", "netuid"],
  ],
  [
    "SubtensorModule.StakeRemoved",
    ["coldkey", "hotkey", "amount_tao", "alpha_amount", "netuid"],
  ],
  [
    "SubtensorModule.StakeMoved",
    [
      "coldkey",
      "hotkey",
      "origin_netuid",
      "destination_hotkey",
      "destination_netuid",
      "amount",
    ],
  ],
  ["SubtensorModule.AxonServed", ["netuid", "hotkey"]],
  ["SubtensorModule.WeightsSet", ["netuid", "uid"]],
  ["SubtensorModule.NetworkAdded", ["netuid"]],
  ["SubtensorModule.NetworkRemoved", ["netuid"]],
  ["SubtensorModule.DelegateAdded", ["coldkey", "hotkey", "take"]],
  ["SubtensorModule.TakeIncreased", ["coldkey", "hotkey", "take"]],
  ["SubtensorModule.TakeDecreased", ["coldkey", "hotkey", "take"]],
  ["SubtensorModule.CRV3WeightsCommitted", ["who", "netuid", "commit_hash"]],
  ["SubtensorModule.CRV3WeightsRevealed", ["netuid", "who"]],
  [
    "SubtensorModule.TimelockedWeightsCommitted",
    ["who", "netuid", "commit_hash", "reveal_round"],
  ],
  ["SubtensorModule.TimelockedWeightsRevealed", ["netuid", "who"]],
  [
    "SubtensorModule.StakeSwapped",
    ["coldkey", "hotkey", "origin_netuid", "destination_netuid", "amount"],
  ],
  [
    "SubtensorModule.StakeTransferred",
    [
      "origin_coldkey",
      "destination_coldkey",
      "hotkey",
      "origin_netuid",
      "destination_netuid",
      "amount",
    ],
  ],
]);

function isByteArray(v, len) {
  return (
    Array.isArray(v) &&
    v.length === len &&
    v.every(
      (n) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 255,
    )
  );
}

// Any-length byte array (every element 0-255), used only by the
// TEXTUAL_FIELDS check below -- gated behind an exact pallet.method.field
// allowlist match, never applied on shape alone, so it can't collide with a
// same-length numeric/typed field elsewhere (e.g. a netuid list) the way a
// generic byte-blob heuristic would.
function isAnyByteArray(v) {
  return (
    Array.isArray(v) &&
    v.every(
      (n) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 255,
    )
  );
}

function toHex(bytes) {
  return "0x" + bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Known free-text/opaque variable-length byte fields, keyed by
// "Pallet.method.field" -- mirrors src/bytes.ts's TEXTUAL_FIELDS (#4689)
// for the analogous call_args gap, scoped narrowly by exact pallet/method/
// field triple rather than any shape heuristic (chain_events.args carries
// no per-field type string, so a length-based guess would risk the same
// collection-vs-blob ambiguity #4693/#4915 avoid elsewhere by consulting a
// typed descriptor's own `type` first -- chain_events has none). Ethereum.
// Executed's extra_data is a miner/relay note, observed live as ASCII
// "Gotta Go Fast" (empty on most blocks). Everything not in this allowlist
// falls through to the generic array-map/object-recurse below, untouched.
const TEXTUAL_FIELDS = new Set(["Ethereum.Executed.extra_data"]);

// Known opaque variable-length byte-blob fields, same narrow allowlist
// discipline as TEXTUAL_FIELDS (and for the same reason -- no per-field type
// string to consult) but decoded as 0x-hex instead of UTF-8: EVM log data and
// contract-emitted data are raw binary payloads (typically ABI-encoded
// parameters), not intended text. Confirmed live 2026-07-12: both fields
// already happened to render as hex on the rare occasion they were exactly
// 32 bytes (isByteArray(value,32) below catches that length coincidentally),
// but stayed a raw, unbounded number array at every other length (64/96/128/
// 224/320/352 bytes all observed live) -- this closes the gap uniformly.
const HEX_BLOB_FIELDS = new Set([
  "EVM.Log.data",
  "Contracts.ContractEmitted.data",
]);

// Known {name, values:[payload]} enum-tree nodes (indexer-rs's generic shape
// for any enum variant carrying data, left otherwise untouched by
// normalizePostgresValue -- see its own module header) worth a further,
// field-specific collapse once `payload` has been fully decoded below. Keyed
// "Pallet.method.field" like the two allowlists above, for the identical
// narrow-allowlist-over-shape-heuristic reason: a generic "collapse any
// single-payload enum tag" rule would risk erasing a genuinely meaningful
// tag/payload pair this codebase hasn't seen yet, so this only ever fires
// for a name explicitly confirmed live below.
//
// - "unwrap": drop the tag, keep only the (now-decoded) payload --
//   Contracts.Called.caller is MultiAddress::Signed(AccountId32); the
//   "Signed" tag carries no information once the account itself is hex, and
//   MultiAddress has no OTHER variant this pallet's caller ever takes.
// - "unit-or-passthrough": if the decoded payload is SCALE's `()` unit
//   (an empty array -- decode()'s own array-map leaves a genuine empty array
//   untouched, so this is unambiguous), collapse to the bare variant name
//   the same way normalizePostgresValue already does for a zero-payload
//   C-like unit enum (Proxy.ProxyExecuted.result / Sudo.Sudid.sudo_result are
//   both Result<(), DispatchError> -- Ok(()) becomes bare "Ok"). Otherwise
//   (a real Err(DispatchError) payload) the tag+payload are left exactly as
//   decoded -- the error detail is meaningful and must not be discarded.
const ENUM_PAYLOAD_FIELDS = new Map([
  ["Contracts.Called.caller", "unwrap"],
  ["Proxy.ProxyExecuted.result", "unit-or-passthrough"],
  ["Sudo.Sudid.sudo_result", "unit-or-passthrough"],
]);

function normalizeChainEventValue(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeChainEventValue);
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (
      keys.length === 2 &&
      keys.includes("name") &&
      keys.includes("values") &&
      typeof value.name === "string" &&
      Array.isArray(value.values)
    ) {
      if (value.name === "Some" && value.values.length === 1) {
        return normalizeChainEventValue(value.values[0]);
      }
      if (value.name === "None" && value.values.length === 0) {
        return null;
      }
      if (value.values.length === 0) {
        return value.name;
      }
      return {
        name: value.name,
        values: value.values.map(normalizeChainEventValue),
      };
    }
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = normalizeChainEventValue(val);
    }
    return out;
  }
  return value;
}

function decodeTextualField(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(bytes),
    );
  } catch {
    // Malformed UTF-8 for a field expected to be textual -- fall back to
    // hex rather than producing mojibake, mirroring bytes.mjs's identical
    // decodeBytesField fallback.
    return toHex(bytes);
  }
}

function decode(value, keyHint, ctx) {
  if (isByteArray(value, 32)) {
    // encodeAccountId32 can't return null here -- isByteArray already
    // confirmed exactly 32 bytes, the only condition it checks internally.
    if (keyHint && ACCOUNT_KEYS.has(keyHint.toLowerCase())) {
      return encodeAccountId32(value);
    }
    return toHex(value);
  }
  // H160 (Ethereum address): a fixed 20-byte type, unambiguous by length --
  // Ethereum.Executed's to/from and EVM.Log's address all match this shape
  // (confirmed live, 2026-07-12). Always hex, never SS58 (that's
  // AccountId32/32-byte territory above).
  if (isByteArray(value, 20)) {
    return toHex(value);
  }
  // indexer-rs newtype-wraps a bare (non-Vec) AccountId32/H160/[u8;N] field
  // in an extra array layer -- `who: [[b0..b31]]` / `to: [[b0..b19]]`, depth
  // 2 -- so it must collapse to a bare decoded value, not `[decoded]`. A
  // genuine `Vec<AccountId32>` stays distinguishable by depth: each of ITS
  // entries is independently newtype-wrapped too (`other_signatories:
  // [[[b..]], [[b..]]]`, depth 3 per entry), so the outer Vec's array-map
  // below still produces one decoded value per entry -- this collapse only
  // fires one layer at a time.
  if (
    Array.isArray(value) &&
    value.length === 1 &&
    (isByteArray(value[0], 32) || isByteArray(value[0], 20))
  ) {
    return decode(value[0], keyHint, ctx);
  }
  if (keyHint && ctx && isAnyByteArray(value)) {
    const key = `${ctx.pallet ?? ""}.${ctx.method ?? ""}.${keyHint}`;
    if (TEXTUAL_FIELDS.has(key)) {
      return decodeTextualField(value);
    }
    if (HEX_BLOB_FIELDS.has(key)) {
      return toHex(value);
    }
  }
  // Arrays inherit the parent key hint (e.g. `who: [<accountId bytes>]`) --
  // this is also what makes an untagged positional args array (no object
  // key at all) correctly fall through to hex: the hint stays undefined at
  // every recursion depth, so the ACCOUNT_KEYS check never fires.
  if (Array.isArray(value)) {
    return value.map((item) => decode(item, keyHint, ctx));
  }
  if (value && typeof value === "object") {
    // Field-specific enum-tag collapse (see ENUM_PAYLOAD_FIELDS above) --
    // checked against the RAW (not-yet-decoded) shape and BEFORE the generic
    // recursion below, so the unwrapped payload can be decoded with the
    // OUTER field's own keyHint (e.g. "caller") instead of the enum
    // wrapper's own "values" key. Decoding generically first and unwrapping
    // `out.values[0]` afterwards (the previous approach) silently lost the
    // outer keyHint across the unwrap -- confirmed live 2026-07-12:
    // Contracts.Called.caller (MultiAddress::Signed(AccountId32)) rendered
    // as raw hex instead of SS58 because by the time its account bytes were
    // reached, decode() had already recursed with keyHint="values", not
    // "caller", so the ACCOUNT_KEYS check never fired.
    if (
      keyHint &&
      ctx &&
      typeof value.name === "string" &&
      Array.isArray(value.values) &&
      value.values.length === 1
    ) {
      const strategy = ENUM_PAYLOAD_FIELDS.get(
        `${ctx.pallet ?? ""}.${ctx.method ?? ""}.${keyHint}`,
      );
      if (strategy === "unwrap") {
        return decode(value.values[0], keyHint, ctx);
      }
      if (strategy === "unit-or-passthrough") {
        const decodedPayload = decode(value.values[0], keyHint, ctx);
        if (Array.isArray(decodedPayload) && decodedPayload.length === 0) {
          return value.name;
        }
        return { name: value.name, values: [decodedPayload] };
      }
    }
    const out = {};
    for (const [k, val] of Object.entries(value)) {
      out[k] = decode(val, k, ctx);
    }
    return out;
  }
  return value;
}

/** Unwraps only Option<T>/C-like unit-variant enum tags first, then decodes
 * account ids and H160 addresses in the result. This intentionally does not
 * use normalizePostgresValue's generic scalar-newtype rule: chain_events.args
 * has no per-field type string, so a legitimate one-element collection like
 * `[78]` or `{uids:[1]}` is indistinguishable from a scalar newtype wrapper by
 * shape alone and must remain an array.
 *
 * Confirmed live 2026-07-11: System.ExtrinsicSuccess's
 * `dispatch_info.class`/`pays_fee` rendered as `{"name":"Normal","values":[]}`
 * instead of the bare string "Normal" -- exactly the shape
 * normalizePostgresValue's C-like-unit-enum rule collapses; and (2026-07-12)
 * Ethereum.Executed's `to`/`from` and EVM.Log's `address` rendered as raw
 * 20-byte arrays instead of hex H160 addresses. A broader live sweep across
 * all 75 distinct chain_events pallet.method combinations (also 2026-07-12)
 * additionally found: several more AccountId32 fields missing from
 * ACCOUNT_KEYS by key-name only (real/proxy/delegatee/delegator/new_hotkey/
 * old_hotkey); EVM.Log.data/Contracts.ContractEmitted.data staying raw byte
 * arrays at every length except the one where they coincidentally matched
 * the 32-byte special case (HEX_BLOB_FIELDS); and three {name,values} enum
 * nodes worth a field-specific collapse once decoded (ENUM_PAYLOAD_FIELDS).
 *
 * `ctx` is the emitting event's `{pallet, method}` (pass `row.pallet`/
 * `row.method` from the Postgres row) -- used by the narrow TEXTUAL_FIELDS/
 * HEX_BLOB_FIELDS/ENUM_PAYLOAD_FIELDS allowlists above AND by
 * POSITIONAL_FIELD_NAMES below; omit it and every other decode still works
 * identically, just without those fields' extra treatment (an untagged
 * positional tuple then has no key hint at any depth, same as before
 * POSITIONAL_FIELD_NAMES existed, and every account inside it renders hex).
 * Deliberately does NOT add a GENERIC byte-blob or enum-collapse heuristic
 * beyond the two fixed byte-array lengths (32/20) and the explicit
 * allowlists -- chain_events.args carries no per-field type string the way
 * extrinsics.call_args does post-#4724, so a length- or shape-based guess
 * for an arbitrary field would risk the same collection-vs-blob ambiguity
 * #4693/#4915 avoid elsewhere by consulting a typed descriptor's own `type`
 * first. */
export function decodeChainEventArgs(args, ctx = null) {
  const normalized = normalizeChainEventValue(args);
  // Untagged positional tuples (a bare array, no key at any depth) get a
  // synthetic per-position key hint for the handful of event kinds this
  // file has confirmed the exact field order for (#5359/#61) -- restores
  // the SAME SS58/hex decision every OTHER (named-object) event already
  // gets, without changing the output shape: still an array, just with
  // correctly-decoded elements instead of raw hex for the account ones. A
  // position past the known names (or an event kind not in the map) falls
  // through to `decode(item, undefined, ctx)`, identical to pre-#5359
  // behavior.
  if (ctx && Array.isArray(normalized)) {
    const names = POSITIONAL_FIELD_NAMES.get(
      `${ctx.pallet ?? ""}.${ctx.method ?? ""}`,
    );
    if (names) {
      return normalized.map((item, i) => decode(item, names[i], ctx));
    }
  }
  return decode(normalized, undefined, ctx);
}
