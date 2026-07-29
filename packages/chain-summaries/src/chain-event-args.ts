import { encodeSs58 } from "./ss58";

// #3984: chain-event args arrive as decoded SCALE values, where account ids are
// raw 32-byte number arrays. Rendered verbatim (`JSON.stringify`) they read like
// `{"who":[[109,111,100,101,...]]}` — unreadable and unbounded. This walks the
// value and rewrites 32-byte arrays into a human-readable form: an SS58 address
// when the field name marks it as an account, otherwise a 0x-hex string (so a
// 32-byte hash isn't mislabelled as an address). Everything else is untouched.

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

function isByteArray(v: unknown, len: number): v is number[] {
  return (
    Array.isArray(v) &&
    v.length === len &&
    v.every((n) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 255)
  );
}

function toHex(bytes: number[]): string {
  return "0x" + bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function decode(value: unknown, keyHint: string | undefined): unknown {
  if (isByteArray(value, 32)) {
    if (keyHint && ACCOUNT_KEYS.has(keyHint.toLowerCase())) {
      return encodeSs58(Uint8Array.from(value)) ?? toHex(value);
    }
    return toHex(value);
  }
  // Arrays inherit the parent key hint (e.g. `who: [<accountId bytes>]`).
  if (Array.isArray(value)) return value.map((item) => decode(item, keyHint));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(value as Record<string, unknown>))
      out[k] = decode(val, k);
    return out;
  }
  return value;
}

/** Decode account ids inside a chain-event args value (leaves everything else as-is). */
export function decodeChainEventArgs(args: unknown): unknown {
  return decode(args, undefined);
}

/**
 * Human-readable one-line string for a chain event's args, with account-id byte
 * arrays decoded to SS58 (or 0x-hex where the field isn't an account). Callers
 * pair this with a truncating cell + a copy button (see blocks.$ref.tsx).
 */
export function formatChainEventArgs(args: unknown): string {
  if (args == null) return "—";
  try {
    return JSON.stringify(decodeChainEventArgs(args)) ?? "—";
  } catch {
    return "[Unserializable value]";
  }
}
