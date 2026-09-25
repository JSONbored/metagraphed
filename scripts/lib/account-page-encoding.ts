import { AccountEventsRowSchema } from "../../schemas-src/lakehouse.ts";
import { ACCOUNT_EVENTS_COLUMNS } from "../../generated/lakehouse/types.ts";
import { decodeAccountPage } from "../../src/history-account-page.ts";
import { feedOrder } from "../../src/history-feed-tree.ts";

export type AccountPageEntry = NonNullable<
  ReturnType<typeof decodeAccountPage>
>[number];
const rowSchema = AccountEventsRowSchema.required();
const stringColumns = new Set([3, 4, 5, 11, 12]);

/** Validate the serving schema and token before either encoding or retaining a page. */
export function validateAccountPageEntries(
  entries: readonly AccountPageEntry[],
): void {
  if (entries.length < 1 || entries.length > 256)
    throw new Error("Invalid account page row count");
  for (const [i, entry] of entries.entries()) {
    if (
      !/^[0-9a-f]{166}$/.test(entry.token) ||
      (i > 0 && entries[i - 1].token >= entry.token) ||
      !Array.isArray(entry.values) ||
      entry.values.length !== ACCOUNT_EVENTS_COLUMNS.length
    )
      throw new Error("Invalid account page token, ordering or row width");
    const row = rowSchema.parse(
      Object.fromEntries(
        ACCOUNT_EVENTS_COLUMNS.map((column, i) => [column, entry.values[i]]),
      ),
    );
    if (
      row.block_number === null ||
      row.event_index === null ||
      row.observed_at === null ||
      feedOrder(row.observed_at, row.block_number, row.event_index) !==
        entry.token.slice(64, 94)
    )
      throw new Error("Account page ordering differs from its row");
  }
}

/** Encode the deployed MGA2 format. Oversized dictionaries retain the legacy page.
 * Every successful encoding is round-tripped through the production decoder,
 * including negative zero and exact UTF-16 strings. */
export function encodeAccountPage(
  entries: readonly AccountPageEntry[],
): Uint8Array | undefined {
  validateAccountPageEntries(entries);
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
    size = start + rows.length * 14 * 8;
  if (size > 256 * 1024) return undefined;
  const raw = new Uint8Array(size),
    view = new DataView(raw.buffer);
  raw.set([0x4d, 0x47, 0x41, 0x32]);
  view.setUint16(4, rows.length, true);
  view.setUint32(6, text.length, true);
  raw.set(text, 10);
  for (let column = 0; column < 14; column++)
    for (let i = 0; i < rows.length; i++) {
      const value = rows[i][column],
        offset = start + (column * rows.length + i) * 8;
      if (value === null) view.setUint32(offset + 4, 0x7ff80000, true);
      else
        view.setFloat64(
          offset,
          typeof value === "string" ? strings.get(value)! : value,
          true,
        );
    }
  const decoded = decodeAccountPage(raw)!;
  for (const [i, entry] of entries.entries())
    if (
      decoded[i].token !== entry.token ||
      entry.values.some((value, j) => !Object.is(value, decoded[i].values[j]))
    )
      throw new Error("Compact account page round-trip changed a value");
  return raw;
}
