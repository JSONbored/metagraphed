/** Exact decimal form of a finite IEEE-754 value, without routing through the
 * shortest display string. This alone does not encode SQLite storage kind. */
export function sqliteNumberDecimal(value: number): string {
  if (!Number.isFinite(value))
    throw new RangeError("SQLite numeric value must be finite");
  if (value === 0) return "0";
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const exponent = Number((bits >> 52n) & 2047n);
  const fraction = bits & ((1n << 52n) - 1n);
  const mantissa = exponent === 0 ? fraction : (1n << 52n) | fraction;
  const power = exponent === 0 ? -1074 : exponent - 1075;
  const negative = bits >> 63n === 1n ? "-" : "";
  if (power >= 0) return negative + (mantissa << BigInt(power)).toString();
  const places = -power;
  const decimal = (mantissa * 5n ** BigInt(places))
    .toString()
    .padStart(places + 1, "0");
  const split = decimal.length - places;
  const fractional = decimal.slice(split).replace(/0+$/, "");
  return (
    negative + decimal.slice(0, split) + (fractional ? `.${fractional}` : "")
  );
}

export function sqliteNumericNumber(value: unknown): number {
  if (
    typeof value !== "number" &&
    (typeof value !== "string" || !/^-?\d+(?:\.\d+)?$/.test(value))
  ) {
    throw new TypeError("Invalid SQLite numeric representation");
  }
  const number = Number(value);
  if (!Number.isFinite(number))
    throw new RangeError("SQLite numeric value must be finite");
  return number;
}

export type SqliteStoredNumber =
  { kind: "integer"; value: bigint } | { kind: "real"; value: number };

const MIN_INT64 = -(1n << 63n);
const MAX_INT64 = (1n << 63n) - 1n;

/** The storage-sensitive numeric codec uses scale zero for INTEGER and a
 * decimal point for REAL, including integral REAL values. PostgreSQL numeric
 * preserves that scale through ::text. Other numeric codecs need not do so. */
export function sqliteStoredNumber(text: string): SqliteStoredNumber {
  const value = sqliteNumericNumber(text);
  if (text.includes(".")) return { kind: "real", value };
  const integer = BigInt(text);
  if (integer < MIN_INT64 || integer > MAX_INT64)
    throw new RangeError("SQLite INTEGER exceeds int64");
  return { kind: "integer", value: integer };
}

/** INTEGER affinity converts an exactly integral REAL inside the int64
 * boundaries. SQLite deliberately leaves a REAL equal to -2^63 as REAL. */
export function sqliteIntegerAffinity(value: number): SqliteStoredNumber {
  if (!Number.isFinite(value))
    throw new RangeError("SQLite numeric value must be finite");
  return Number.isInteger(value) &&
    value > Number(MIN_INT64) &&
    value < Number(MAX_INT64)
    ? { kind: "integer", value: BigInt(value) }
    : { kind: "real", value };
}

/** SQLite adds two INTEGER operands exactly until int64 overflow, then uses
 * binary64 operands. Mixed or REAL additions use binary64 from the outset. */
export function sqliteAddNumbers(
  left: SqliteStoredNumber,
  right: SqliteStoredNumber,
): SqliteStoredNumber {
  if (left.kind === "integer" && right.kind === "integer") {
    const sum = left.value + right.value;
    if (sum >= MIN_INT64 && sum <= MAX_INT64)
      return { kind: "integer", value: sum };
  }
  return { kind: "real", value: Number(left.value) + Number(right.value) };
}

/** Apply the destination column's INTEGER affinity and retain any resulting
 * REAL marker. Do not use this to normalize imported source cells. */
export function sqliteStoredNumberText(value: SqliteStoredNumber): string {
  const stored =
    value.kind === "real" ? sqliteIntegerAffinity(value.value) : value;
  if (stored.kind === "integer") return stored.value.toString();
  const text = sqliteNumberDecimal(stored.value);
  return text.includes(".") ? text : `${text}.0`;
}
