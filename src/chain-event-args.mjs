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
// Executed's extra_data). Everything else is untouched.
import { encodeAccountId32 } from "./ss58.mjs";
import { normalizePostgresValue } from "./scale-normalize.mjs";

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
// "Pallet.method.field" -- mirrors src/bytes.mjs's TEXTUAL_FIELDS (#4689)
// for the analogous call_args gap, scoped narrowly by exact pallet/method/
// field triple rather than any shape heuristic (chain_events.args carries
// no per-field type string, so a length-based guess would risk the same
// collection-vs-blob ambiguity #4693/#4915 avoid elsewhere by consulting a
// typed descriptor's own `type` first -- chain_events has none). Ethereum.
// Executed's extra_data is a miner/relay note, observed live as ASCII
// "Gotta Go Fast" (empty on most blocks). Everything not in this allowlist
// falls through to the generic array-map/object-recurse below, untouched.
const TEXTUAL_FIELDS = new Set(["Ethereum.Executed.extra_data"]);

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
  }
  // Arrays inherit the parent key hint (e.g. `who: [<accountId bytes>]`) --
  // this is also what makes an untagged positional args array (no object
  // key at all) correctly fall through to hex: the hint stays undefined at
  // every recursion depth, so the ACCOUNT_KEYS check never fires.
  if (Array.isArray(value)) {
    return value.map((item) => decode(item, keyHint, ctx));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, val] of Object.entries(value)) out[k] = decode(val, k, ctx);
    return out;
  }
  return value;
}

/** Unwraps Option<T>/C-like unit-variant enum tags via normalizePostgresValue
 * (#4690's generic pass) FIRST, then decodes account ids and H160 addresses
 * in the result. This order (opposite of src/extrinsics.mjs's
 * formatExtrinsic, which runs its nested-call reconstruction before
 * normalizePostgresValue for an unrelated reason specific to that pass --
 * see its own header) is required here, not merely conventional: running
 * the byte-array decode FIRST turns each element of a single-entry
 * Vec<H256>-shaped field (e.g. EVM.Log's `topics` with exactly one topic)
 * into a plain hex STRING, which normalizePostgresValue's newtype-scalar
 * rule would then wrongly collapse from `["0x...hash"]` down to a bare
 * `"0x...hash"` -- silently changing the field's JSON type from array to
 * scalar (confirmed live 2026-07-12: a real single-topic EVM.Log). Running
 * normalizePostgresValue first avoids this: at that point every byte-array
 * field's elements are still raw integers (0-255), never scalar-shaped
 * wrapped values, so its newtype-scalar rule can never fire on a pristine
 * byte array or its 1-element newtype wrapper -- confirmed safe against
 * every existing fixture in this file's own test suite, including the
 * single-element Vec<AccountId32> case.
 *
 * Confirmed live 2026-07-11: System.ExtrinsicSuccess's
 * `dispatch_info.class`/`pays_fee` rendered as `{"name":"Normal","values":[]}`
 * instead of the bare string "Normal" -- exactly the shape
 * normalizePostgresValue's C-like-unit-enum rule collapses; and (2026-07-12)
 * Ethereum.Executed's `to`/`from` and EVM.Log's `address` rendered as raw
 * 20-byte arrays instead of hex H160 addresses.
 *
 * `ctx` is the emitting event's `{pallet, method}` (pass `row.pallet`/
 * `row.method` from the Postgres row) -- used only by the narrow
 * TEXTUAL_FIELDS allowlist above; omit it and every other decode still
 * works identically, just without that one field's UTF-8 treatment.
 * Deliberately does NOT add a GENERIC byte-blob heuristic beyond the two
 * fixed lengths (32/20) and the explicit allowlist -- chain_events.args
 * carries no per-field type string the way extrinsics.call_args does
 * post-#4724, so a length-based guess for an arbitrary-length field would
 * risk the same collection-vs-blob ambiguity #4693/#4915 avoid elsewhere by
 * consulting a typed descriptor's own `type` first. */
export function decodeChainEventArgs(args, ctx = null) {
  return decode(normalizePostgresValue(args), undefined, ctx);
}
