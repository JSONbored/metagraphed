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

// Encode an array of non-negative SAFE integers into a cursor token. Returns null
// for an empty/invalid input (the caller then emits no next_cursor). Parts must be
// safe integers — a value above Number.MAX_SAFE_INTEGER can't survive the
// Number()/round-trip the decoder performs, so it is not a representable cursor.
export function encodeCursor(parts) {
  if (!Array.isArray(parts) || parts.length === 0) return null;
  if (parts.some((p) => !Number.isSafeInteger(p) || p < 0)) return null;
  return parts.join(".");
}

// Decode a cursor token back to exactly `arity` non-negative integers. Returns
// null on any malformed/garbage input (the handler then ignores the cursor),
// preserving the never-throw contract of the chain routes.
export function decodeCursor(raw, arity) {
  if (typeof raw !== "string" || raw === "") return null;
  const segs = raw.split(".");
  if (segs.length !== arity) return null;
  const parts = [];
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
