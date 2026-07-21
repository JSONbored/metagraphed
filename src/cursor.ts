// Opaque-by-convention keyset (seek) cursor for the head-growing chain feeds
// (#1851): blocks, extrinsics, account events. These are PK-ordered D1 reads where
// pure OFFSET pagination corrupts under head-of-chain inserts (new finalized blocks
// shift the window, producing duplicates/skips) and degrades at depth. A keyset
// cursor encodes the composite sort key of the last row (e.g. [block_number,
// extrinsic_index]) so the next page is a row-value comparison, stable + O(log n).
//
// The token is a dot-joined string of the non-negative integer parts (URL-safe as
// is, no encoding dependency). It is a STRING, deliberately distinct from the
// integer `meta.pagination.next_cursor` the artifact list-query collections use —
// those are offset aliases over in-memory collections; these are composite PK seeks
// over D1. Callers should treat the token as opaque. Exposed as `?cursor=` + a
// `next_cursor` body field.

// Normalize one cursor part: non-negative safe integers, or D1-style numeric
// strings (decodeCursor accepts `/^\d+$/` segments; encode must be symmetric).
function cursorPart(value: number | string): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const n = Number(value);
    if (Number.isSafeInteger(n) && n >= 0) return n;
  }
  return null;
}

// Encode cursor parts into a dot-joined token. Each part may be a non-negative
// safe integer or a digit string that normalizes to one (D1 INTEGER columns often
// arrive as strings). Returns null for empty/invalid input (no next_cursor).
// Values above Number.MAX_SAFE_INTEGER are rejected — they cannot survive the
// Number() round-trip the decoder performs.
export function encodeCursor(parts: Array<number | string>): string | null {
  if (!Array.isArray(parts) || parts.length === 0) return null;
  const normalized: number[] = [];
  for (const part of parts) {
    const n = cursorPart(part);
    if (n == null) return null;
    normalized.push(n);
  }
  return normalized.join(".");
}

// Decode a cursor token back to exactly `arity` non-negative integers. Returns
// null on any malformed/garbage input (the handler then ignores the cursor),
// preserving the never-throw contract of the chain routes.
export function decodeCursor(raw: unknown, arity: number): number[] | null {
  if (typeof raw !== "string" || raw === "") return null;
  const segs = raw.split(".");
  if (segs.length !== arity) return null;
  const parts: number[] = [];
  for (const s of segs) {
    if (!/^\d+$/.test(s)) return null;
    const n = Number(s);
    // Reject parts outside the SAFE integer range — `/^\d+$/` admits arbitrarily
    // long digit strings, and `Number()` silently rounds anything above
    // MAX_SAFE_INTEGER (e.g. "9007199254740993" -> 9007199254740992), which
    // `Number.isInteger` would still accept and hand back as a corrupted seek key.
    // Mirror the offset-pagination sibling `integerParam` (workers/list-query.mjs),
    // which gates on `Number.isSafeInteger`, so an out-of-range cursor is ignored.
    if (!Number.isSafeInteger(n) || n < 0) return null;
    parts.push(n);
  }
  return parts;
}
