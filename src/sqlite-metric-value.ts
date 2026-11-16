import type { SqliteDocumentValue } from "./sqlite-document-decoder.ts";

export type SqliteMetricScalar = Exclude<SqliteDocumentValue, Uint8Array>;

/** SQLite orders NULL, numbers, then raw UTF-8 TEXT. Compare integers before
 * converting to JavaScript numbers, and text before D1 wire replacement. */
export function compareSqliteMetric(
  left: SqliteMetricScalar,
  leftBytes: Uint8Array | undefined,
  right: SqliteMetricScalar,
  rightBytes: Uint8Array | undefined,
): number {
  if (left === null) return right === null ? 0 : -1;
  if (right === null) return 1;
  if (typeof left === "string")
    return typeof right === "string"
      ? Buffer.compare(leftBytes!, rightBytes!)
      : 1;
  if (typeof right === "string") return -1;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sqliteMetricWireValue(value: SqliteDocumentValue): unknown {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number")
    return Number.isFinite(value) ? (value === 0 ? 0 : value) : null;
  return value;
}
