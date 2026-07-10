// Server-side port of apps/ui/src/lib/metagraphed/chain-event-args.ts (#3984,
// PR #4621) -- that fix decoded chain-event args client-side, but only inside
// apps/ui/src/routes/blocks.$ref.tsx. Every other consumer of the same
// chain_events.args column (the REST /api/v1/chain-events routes and the
// list_chain_events/get_block_chain_events/get_extrinsic_chain_events MCP
// tools, all served unconditionally with no D1 fallback) still got the raw
// shape. This decodes once, server-side, so every consumer sees the same
// human-readable values (#4685).
//
// chain-event args arrive as decoded SCALE values, where account ids are raw
// 32-byte number arrays (indexer-rs's generic dynamic-value dump wraps a
// tuple-struct-with-one-field like AccountId32([u8;32]) in an extra array
// layer -- [[b0..b31]], not a flat 32-byte array). Rendered verbatim they
// read like `{"who":[[109,111,100,101,...]]}` -- unreadable and unbounded.
// This walks the value and rewrites 32-byte arrays into a human-readable
// form: an SS58 address when the field name marks it as an account,
// otherwise a 0x-hex string (so a 32-byte hash isn't mislabelled as an
// address, and an untagged positional arg with no key hint -- e.g. a
// non-System/Balances pallet event's args tuple -- always falls to hex
// rather than guessing). Everything else is untouched.
import { encodeAccountId32 } from "./ss58.mjs";

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

function toHex(bytes) {
  return "0x" + bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function decode(value, keyHint) {
  if (isByteArray(value, 32)) {
    // encodeAccountId32 can't return null here -- isByteArray already
    // confirmed exactly 32 bytes, the only condition it checks internally.
    if (keyHint && ACCOUNT_KEYS.has(keyHint.toLowerCase())) {
      return encodeAccountId32(value);
    }
    return toHex(value);
  }
  // indexer-rs newtype-wraps a bare (non-Vec) AccountId32/[u8;32] field in an
  // extra array layer -- `who: [[b0..b31]]`, depth 2 -- so it must collapse
  // to a bare decoded value, not `[decoded]`. A genuine `Vec<AccountId32>`
  // stays distinguishable by depth: each of ITS entries is independently
  // newtype-wrapped too (`other_signatories: [[[b..]], [[b..]]]`, depth 3
  // per entry), so the outer Vec's array-map below still produces one
  // decoded value per entry -- this collapse only fires one layer at a time.
  if (Array.isArray(value) && value.length === 1 && isByteArray(value[0], 32)) {
    return decode(value[0], keyHint);
  }
  // Arrays inherit the parent key hint (e.g. `who: [<accountId bytes>]`) --
  // this is also what makes an untagged positional args array (no object
  // key at all) correctly fall through to hex: the hint stays undefined at
  // every recursion depth, so the ACCOUNT_KEYS check never fires.
  if (Array.isArray(value)) return value.map((item) => decode(item, keyHint));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, val] of Object.entries(value)) out[k] = decode(val, k);
    return out;
  }
  return value;
}

/** Decode account ids inside a chain-event args value (leaves everything else as-is). */
export function decodeChainEventArgs(args) {
  return decode(args, undefined);
}
