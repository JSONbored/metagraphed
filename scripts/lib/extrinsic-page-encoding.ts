import {
  decodeExtrinsicPage,
  ExtrinsicFeedRecordSchema,
} from "../../src/history-extrinsic-page.ts";
import { feedOrder } from "../../src/history-feed-tree.ts";

export type ExtrinsicPageEntry = NonNullable<
  ReturnType<typeof decodeExtrinsicPage>
>[number];
const stringColumns = new Set([3, 4, 5, 8, 9]);

/** Validate the serving schema and token before either encoding or retaining a page. */
export function validateExtrinsicPageEntries(
  entries: readonly ExtrinsicPageEntry[],
): void {
  if (entries.length < 1 || entries.length > 256)
    throw new Error("Invalid extrinsic page row count");
  for (const [i, entry] of entries.entries()) {
    if (
      !/^[0-9a-f]{166}$/.test(entry.token) ||
      (i > 0 && entries[i - 1].token >= entry.token) ||
      !Array.isArray(entry.values) ||
      entry.values.length !== 8
    )
      throw new Error("Invalid extrinsic page token, ordering or row width");
    const row = ExtrinsicFeedRecordSchema.parse(entry.values);
    if (feedOrder(row[2], row[0], row[1]) !== entry.token.slice(64, 94))
      throw new Error("Extrinsic page ordering differs from its row");
  }
}

/** Encode MGE1 transaction pointers. Oversized dictionaries retain the legacy page.
 * Every successful encoding is round-tripped through the production decoder,
 * including negative zero and exact UTF-16 strings. */
export function encodeExtrinsicPage(
  entries: readonly ExtrinsicPageEntry[],
): Uint8Array | undefined {
  validateExtrinsicPageEntries(entries);
  const dictionary: string[] = [],
    strings = new Map<string, number>();
  let codeUnits = 0;
  const rows = entries.map(({ token, values }) => [
    ...values,
    token.slice(0, 64),
    token.slice(94, 158),
    Number.parseInt(token.slice(158), 16),
  ]);
  for (const row of rows)
    for (const column of stringColumns) {
      const value = row[column];
      if (typeof value === "string" && !strings.has(value)) {
        strings.set(value, dictionary.length);
        dictionary.push(value);
        codeUnits += value.length;
        if (codeUnits > 256 * 1024) return undefined;
      }
    }
  const text = new TextEncoder().encode(JSON.stringify(dictionary));
  const start = 10 + text.length,
    size = start + rows.length * 11 * 8;
  if (size > 256 * 1024) return undefined;
  const raw = new Uint8Array(size),
    view = new DataView(raw.buffer);
  raw.set([0x4d, 0x47, 0x45, 0x31]);
  view.setUint16(4, rows.length, true);
  view.setUint32(6, text.length, true);
  raw.set(text, 10);
  for (let column = 0; column < 11; column++)
    for (let i = 0; i < rows.length; i++) {
      const value = rows[i][column],
        offset = start + (column * rows.length + i) * 8;
      if (value === null) view.setUint32(offset + 4, 0x7ff80000, true);
      else
        view.setFloat64(
          offset,
          typeof value === "string"
            ? strings.get(value)!
            : typeof value === "boolean"
              ? Number(value)
              : value,
          true,
        );
    }
  const decoded = decodeExtrinsicPage(raw)!;
  for (const [i, entry] of entries.entries())
    if (
      decoded[i].token !== entry.token ||
      entry.values.some((value, j) => !Object.is(value, decoded[i].values[j]))
    )
      throw new Error("Compact extrinsic page round-trip changed a value");
  return raw;
}
