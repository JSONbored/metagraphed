import { z } from "zod";
import { feedOrder } from "./history-feed-tree.ts";

const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const strings = new Set([3, 4, 5, 8, 9]);
const integer = z.number().int().nonnegative();
export const ExtrinsicFeedRecordSchema = z.tuple([
  integer.max(0xffffffff),
  integer.max(0xffffffff),
  integer.max(Number.MAX_SAFE_INTEGER),
  z.string().nullable(),
  z.string().nullable(),
  z.string().nullable(),
  z.boolean().nullable(),
  integer.max(0xffffffff),
]);

/** MGE1: JSON dictionary and eleven float64 LE columns, including query/source
 * identity and row ordinal. Boolean filters use only 0/1; canonical quiet NaN
 * is null. JSON dictionaries preserve exact UTF-16 strings. The outer gzip and
 * tree census are still checked by the shared bounded feed reader. */
export function decodeExtrinsicPage(
  raw: Uint8Array,
):
  | { token: string; values: (number | string | boolean | null)[] }[]
  | undefined {
  if (raw[0] !== 0x4d) return undefined;
  if (
    raw.length < 10 ||
    raw.length > 256 * 1024 ||
    text.decode(raw.subarray(0, 4)) !== "MGE1"
  )
    throw new Error("Invalid compact extrinsic page header");
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const count = view.getUint16(4, true);
  const start = 10 + view.getUint32(6, true);
  if (count < 1 || count > 256 || start + count * 11 * 8 !== raw.length)
    throw new Error("Invalid compact extrinsic page dimensions");
  const dictionary: unknown = JSON.parse(text.decode(raw.subarray(10, start)));
  if (
    !Array.isArray(dictionary) ||
    dictionary.length > count * 5 ||
    dictionary.some((value: unknown) => typeof value !== "string")
  )
    throw new Error("Invalid compact extrinsic page dictionary");
  const rows: (number | string | boolean | null)[][] = Array.from(
    { length: count },
    () => [],
  );
  for (let column = 0; column < 11; column++) {
    for (let index = 0; index < count; index++) {
      const offset = start + (column * count + index) * 8;
      const value = view.getFloat64(offset, true);
      if (
        view.getUint32(offset, true) === 0 &&
        view.getUint32(offset + 4, true) === 0x7ff80000
      ) {
        rows[index].push(null);
      } else if (!Number.isFinite(value)) {
        throw new Error("Invalid compact extrinsic page number");
      } else if (strings.has(column)) {
        if (!Number.isInteger(value) || value < 0 || value >= dictionary.length)
          throw new Error("Invalid compact extrinsic page string index");
        rows[index].push(dictionary[value]);
      } else if (column === 6) {
        if (value !== 0 && value !== 1)
          throw new Error("Invalid compact extrinsic page boolean");
        rows[index].push(value === 1);
      } else rows[index].push(value);
    }
  }
  return rows.map((row) => {
    const [query, source, ordinal] = row.slice(8);
    const [block, event] = row;
    const observed = row[2];
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
      throw new Error("Invalid compact extrinsic page identity");
    return {
      token:
        query +
        feedOrder(observed, block, event) +
        source +
        ordinal.toString(16).padStart(8, "0"),
      values: ExtrinsicFeedRecordSchema.parse(row.slice(0, 8)),
    };
  });
}
