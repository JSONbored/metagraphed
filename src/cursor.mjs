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

// Encode an array of non-negative integers into a cursor token. Returns null for
// an empty/invalid input (the caller then emits no next_cursor).
export function encodeCursor(parts) {
  if (!Array.isArray(parts) || parts.length === 0) return null;
  if (parts.some((p) => !Number.isInteger(p) || p < 0)) return null;
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
    if (!Number.isInteger(n) || n < 0) return null;
    parts.push(n);
  }
  return parts;
}
