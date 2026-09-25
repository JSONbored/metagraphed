import { feedOrder } from "./history-feed-tree.ts";

const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const strings = new Set([3, 4, 5, 11, 12]);

/** MGA2: header, JSON string dictionary, then fourteen float64 LE columns.
 * The first eleven columns are the complete account row; the final three
 * retain query hash, source hash and source ordinal. Only the canonical quiet
 * NaN represents null. Dictionary JSON preserves even escaped UTF-16 surrogates.
 * Legacy JSONL pages remain valid inside a mixed-generation tree.
 */
export function decodeAccountPage(
  raw: Uint8Array,
): { token: string; values: (number | string | null)[] }[] | undefined {
  if (raw[0] !== 0x4d) return undefined;
  if (
    raw.length < 10 ||
    raw.length > 256 * 1024 ||
    text.decode(raw.subarray(0, 4)) !== "MGA2"
  )
    throw new Error("Invalid compact account page header");
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const count = view.getUint16(4, true);
  const start = 10 + view.getUint32(6, true);
  if (count < 1 || count > 256 || start + count * 14 * 8 !== raw.length)
    throw new Error("Invalid compact account page dimensions");
  const dictionary: unknown = JSON.parse(text.decode(raw.subarray(10, start)));
  if (
    !Array.isArray(dictionary) ||
    dictionary.length > count * 5 ||
    dictionary.some((value: unknown) => typeof value !== "string")
  )
    throw new Error("Invalid compact account page dictionary");
  const rows: (number | string | null)[][] = Array.from(
    { length: count },
    () => [],
  );
  for (let column = 0; column < 14; column++) {
    for (let index = 0; index < count; index++) {
      const offset = start + (column * count + index) * 8;
      const value = view.getFloat64(offset, true);
      if (
        view.getUint32(offset, true) === 0 &&
        view.getUint32(offset + 4, true) === 0x7ff80000
      ) {
        rows[index].push(null);
      } else if (!Number.isFinite(value)) {
        throw new Error("Invalid compact account page number");
      } else if (strings.has(column)) {
        if (!Number.isInteger(value) || value < 0 || value >= dictionary.length)
          throw new Error("Invalid compact account page string index");
        rows[index].push(dictionary[value]);
      } else rows[index].push(value);
    }
  }
  return rows.map((row) => {
    const [query, source, ordinal] = row.slice(11);
    const [block, event] = row;
    const observed = row[10];
    if (
      typeof query !== "string" ||
      !/^[0-9a-f]{64}$/.test(query) ||
      typeof source !== "string" ||
      !/^[0-9a-f]{64}$/.test(source) ||
      typeof ordinal !== "number" ||
      !Number.isInteger(ordinal) ||
      ordinal < 0 ||
      ordinal > 0xffffffff ||
      typeof block !== "number" ||
      typeof event !== "number" ||
      typeof observed !== "number"
    )
      throw new Error("Invalid compact account page identity");
    return {
      token:
        query +
        feedOrder(observed, block, event) +
        source +
        ordinal.toString(16).padStart(8, "0"),
      values: row.slice(0, 11),
    };
  });
}
