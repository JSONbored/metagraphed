// Block feeds order by chain height, independently of when repair observed a
// row. Version the opaque token: deployed two-part tokens keep their old seek.
import { decodeCursor, encodeCursor } from "./cursor.ts";

export interface BlockFeedCursor {
  mode: "height" | "legacy-height" | "observed";
  height: number | null;
  observed: number | null;
  source: number | null;
  ordinal: number | null;
}

export function decodeBlockFeedCursor(raw: unknown): BlockFeedCursor | null {
  if (typeof raw === "string" && raw.startsWith("bh1.")) {
    const pieces = raw.slice(4).split(".");
    if (pieces.length !== 4) return null;
    const parts: (number | null)[] = [];
    for (const piece of pieces) {
      if (piece === "n") parts.push(null);
      else {
        const number = decodeCursor(piece, 1)?.[0];
        if (number === undefined) return null;
        parts.push(number);
      }
    }
    const [height, observed, source, ordinal] = parts as [number|null,number|null,number|null,number|null];
    if ((source === null) !== (ordinal === null) || (height === null && source === null)) return null;
    return {mode: "height", height, observed, source, ordinal};
  }
  const pair = decodeCursor(raw, 2);
  if (pair) return {mode: "observed",height: pair[1]!,observed: pair[0]!,source: null,ordinal: null};
  const single = decodeCursor(raw, 1);
  return single ? {mode: "legacy-height",height: single[0]!,observed: null,source: null,ordinal: null} : null;
}

export function encodeBlockFeedCursor(row: Record<string, unknown>, previous: BlockFeedCursor | null): string | null {
  if (previous?.mode === "observed") return encodeCursor([row.observed_at as number|null,row.block_number as number|null]);
  if (previous?.mode === "legacy-height") return encodeCursor([row.block_number as number|null]);
  const source = row._source_id ?? null, ordinal = row._ordinal ?? null;
  if ((source === null) !== (ordinal === null) || (row.block_number == null && source === null)) return null;
  const values = [row.block_number ?? null,row.observed_at ?? null,source,ordinal];
  const pieces: string[] = [];
  for (const value of values) {
    if (value === null) pieces.push("n");
    else {
      const encoded = encodeCursor([value as number]);
      if (encoded === null) return null;
      pieces.push(encoded);
    }
  }
  return `bh1.${pieces.join(".")}`;
}

/** Safe literal predicates: every numeric part passed the shared integer codec.
 * Height DESC NULLS LAST; observation ASC NULLS FIRST; physical identity DESC.
 * The latter keys preserve identical retained rows using the existing height
 * index's reverse scan, without a new large index or a network-wide time sort.
 */
export function blockFeedSeek(cursor: BlockFeedCursor): string {
  if (cursor.mode === "observed") return `(observed_at, block_number) < (${cursor.observed}, ${cursor.height})`;
  const lower = cursor.height === null ? "block_number IS NULL" : `(block_number < ${cursor.height} OR block_number IS NULL)`;
  if (cursor.source === null) return lower;
  const physical = `(b.source_id,b.ordinal) < (${cursor.source},${cursor.ordinal})`;
  const sameTime = cursor.observed === null
    ? `(observed_at IS NOT NULL OR (observed_at IS NULL AND ${physical}))`
    : `(observed_at > ${cursor.observed} OR (observed_at = ${cursor.observed} AND ${physical}))`;
  const sameHeight = cursor.height === null ? "block_number IS NULL" : `block_number = ${cursor.height}`;
  return cursor.height === null ? `(${sameHeight} AND ${sameTime})` : `(${lower} OR (${sameHeight} AND ${sameTime}))`;
}
