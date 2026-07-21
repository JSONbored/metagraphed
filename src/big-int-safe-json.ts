// Fixes a real defect the Gittensory review caught on #4692 (PR #4719):
// standard JSON.parse silently rounds any bare integer literal past
// Number.MAX_SAFE_INTEGER (2^53-1) to the nearest representable float64 --
// this happens BEFORE any field-aware decoder (decodeU256Limbs,
// normalizePostgresValue's newtype-scalar unwrap) ever sees the value, so no
// amount of downstream BigInt reconstruction can recover the lost precision.
// Postgres's call_args::text column preserves large integers EXACTLY
// (confirmed: a stored literal like 9131459485341369597 round-trips through
// `SELECT call_args::text` unchanged) -- the corruption is purely an
// artifact of JS's own JSON.parse, the same mechanism already accepted for
// SubtensorModule.register's PoW nonce (D1 serves 9131459485341369000 vs the
// true 9131459485341369597 -- this is that same bug, not a D1-specific one).
//
// Approach: before handing the text to JSON.parse, wrap any bare integer
// literal that would lose precision in quotes, so it survives as an exact
// string instead. Downstream numeric-field decoders (decodeU256Limbs) then
// accept either a small JS number OR a numeric string for each component,
// since only the SPECIFIC values large enough to need it get quoted -- most
// call_args numbers (netuid, small amounts, the other 3 zero limbs in a
// typical U256) stay plain JS numbers, untouched.
//
// The regex alternates between a full JSON string literal (consumed whole,
// so digits inside a string -- an SS58 address, a hex blob -- are never
// mistaken for a bare number) and a bare JSON number literal. Regex
// alternation always tries the string branch first at each match position,
// so a string token is fully consumed before the number branch ever gets a
// chance to look inside it.
const JSON_STRING_OR_NUMBER =
  /"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

function quoteUnsafeIntegers(text: string): string {
  return text.replace(JSON_STRING_OR_NUMBER, (token) => {
    if (token[0] === '"') return token; // already a string -- leave untouched
    if (!/^-?\d+$/.test(token)) return token; // has a decimal point/exponent -- not a bare integer, Number() already the only sane representation
    return Number.isSafeInteger(Number(token)) ? token : `"${token}"`;
  });
}

/** JSON.parse with large bare integer literals preserved as exact strings
 * instead of silently rounded to the nearest float64. A no-op transform
 * (identical result to plain JSON.parse) on any JSON text with no integer
 * literal past Number.MAX_SAFE_INTEGER -- which is every call_args payload
 * except the specific numeric fields (U256 limbs, u64 PoW nonces, ...) large
 * enough to need it. */
export function parseJsonPreservingBigInts(text: string): unknown {
  return JSON.parse(quoteUnsafeIntegers(text));
}
