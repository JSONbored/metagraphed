// Postgres's json/jsonb columns store numeric literals with full precision
// (confirmed live: `args::text` for a real SubtensorModule.DifficultySet row
// reads the exact digit string "18446744073709551615", u64::MAX) -- but the
// `postgres` npm client's built-in json/jsonb parser (node_modules/postgres/
// cjs/src/types.js, OIDs 114/3802) is a bare `JSON.parse(x)`, which silently
// rounds any integer literal beyond Number.MAX_SAFE_INTEGER (2^53-1) to the
// nearest representable float64 -- "18446744073709551615" becomes the JS
// number 18446744073709552000, a DIFFERENT value, before src/chain-event-
// args.mjs (or anything else reading a jsonb column through this client)
// ever sees it. Confirmed live 2026-07-12 in three chain_events.args fields
// (SubtensorModule.DifficultySet/SetChildren/SetChildrenScheduled) carrying
// u64 sentinel/fixed-point values in this range. Does NOT apply to
// extrinsics.call_args -- that column is queried with an explicit `::text`
// cast (workers/data-api.mjs) specifically so src/extrinsics.ts's own,
// separately-gated big-int handling (src/big-int-safe-json.mjs, scoped only
// to Ethereum/EVM call types) runs instead; after the cast the wire type is
// `text`, not `json`/`jsonb`, so this module's parser is never invoked for
// it.
//
// Fix: pre-process the raw JSON text before handing it to JSON.parse,
// quoting any bare (unquoted) integer literal that exceeds the safe-integer
// range so it round-trips as an exact string instead of a lossy number --
// the same convention large-integer chain/financial APIs commonly use (e.g.
// a u64 stays a string, not a number, past 2^53). Quoted string CONTENTS
// (including one that happens to look like a long digit run, e.g. an SS58
// address or a hex hash) are matched and passed through unchanged by the
// same regex, never touched by the integer branch.
const JSON_TOKEN_RE = /"(?:[^"\\]|\\.)*"|-?\d+(\.\d+)?([eE][+-]?\d+)?/g;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = -MAX_SAFE;

function quoteUnsafeIntegers(text: string): string {
  return text.replace(JSON_TOKEN_RE, (match, decimalPart, exponentPart) => {
    // A quoted string always starts with '"' -- the alternation above can
    // only otherwise match a bare number, so this check alone distinguishes
    // the two branches without needing a separate capture group.
    if (match.charCodeAt(0) === 34) return match;
    // A literal with a fractional or exponent part isn't the u64/u128
    // sentinel-integer shape this fix targets -- float precision loss for
    // those is a different, unobserved concern; leave them exactly as
    // JSON.parse would have handled them.
    if (decimalPart || exponentPart) return match;
    const big = BigInt(match);
    return big > MAX_SAFE || big < MIN_SAFE ? `"${match}"` : match;
  });
}

/** Drop-in replacement for `JSON.parse` that preserves exact precision for
 * integer literals beyond Number.MAX_SAFE_INTEGER by returning them as
 * strings instead of numbers -- everything else parses identically to the
 * native JSON.parse. Intended for the `postgres` client's json/jsonb type
 * parser (OIDs 114/3802) so every reader of a genuine json/jsonb column
 * (decodeChainEventArgs, ...) already sees the exact value with no
 * additional per-call-site handling required. */
export function parseJsonPreservingBigIntegers(text: string): unknown {
  return JSON.parse(quoteUnsafeIntegers(text));
}
