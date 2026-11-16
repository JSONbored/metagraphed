import {
  sqliteStoredNumber,
  sqliteStoredNumberText,
  type SqliteStoredNumber,
} from "./sqlite-number.ts";

const MIN_INT64 = -(1n << 63n);
const MAX_INT64 = (1n << 63n) - 1n;
const SPLIT_AT = 1n << 52n;

/** Aggregate counters may contain a REAL infinity; quota counters may not. */
export function sqliteAggregateNumber(text: string): SqliteStoredNumber {
  if (text === "Infinity") return { kind: "real", value: Infinity };
  if (text === "-Infinity") return { kind: "real", value: -Infinity };
  return sqliteStoredNumber(text);
}

export function sqliteAggregateText(value: SqliteStoredNumber | null): string {
  if (value === null || (value.kind === "real" && Number.isNaN(value.value)))
    throw new TypeError("SQLite aggregate counter is NULL");
  if (value.kind === "real" && !Number.isFinite(value.value))
    return value.value > 0 ? "Infinity" : "-Infinity";
  return sqliteStoredNumberText(value);
}

/** JSON1 parses the serialized number, not the original JS binary64 value.
 * An integral decimal token can therefore become a different exact INTEGER. */
export function sqliteJsonNumber(value: number): SqliteStoredNumber {
  if (!Number.isFinite(value))
    throw new TypeError("JSON numeric input must be finite");
  const text = JSON.stringify(value);
  if (/^-?\d+$/.test(text)) {
    const integer = BigInt(text);
    if (integer >= MIN_INT64 && integer <= MAX_INT64)
      return { kind: "integer", value: integer };
  }
  return { kind: "real", value: Number(text) };
}

/** SQLite's SUM accumulator, including integer-overflow refusal, compensated
 * floating arithmetic and NULL for an indeterminate infinity cancellation.
 * Source: public-domain SQLite src/func.c at 696155ad01f8cbf35b994b7a3d15b00f880d910f.
 * Actual D1 differential tests remain the authority for the deployed behavior. */
export function createSqliteSum() {
  let count = 0;
  let integer = 0n;
  let approximate = false;
  let overflow = false;
  let total = 0;
  let error = 0;
  const step = (value: number) => {
    const previous = total;
    const next = previous + value;
    error +=
      Math.abs(previous) > Math.abs(value)
        ? previous - next + value
        : value - next + previous;
    total = next;
  };
  const stepInteger = (value: bigint) => {
    if (value <= -SPLIT_AT || value >= SPLIT_AT) {
      const small = value % 16384n;
      step(Number(value - small));
      step(Number(small));
    } else step(Number(value));
  };
  const initialize = () => {
    if (integer <= -SPLIT_AT || integer >= SPLIT_AT) {
      const small = integer % 16384n;
      total = Number(integer - small);
      error = Number(small);
    } else {
      total = Number(integer);
      error = 0;
    }
    approximate = true;
  };
  return {
    add(value: SqliteStoredNumber | null): void {
      if (value === null) return;
      count += 1;
      if (!approximate) {
        if (value.kind === "real") {
          initialize();
          step(value.value);
        } else {
          const next = integer + value.value;
          if (next >= MIN_INT64 && next <= MAX_INT64) integer = next;
          else {
            overflow = true;
            initialize();
            stepInteger(value.value);
          }
        }
      } else if (value.kind === "integer") stepInteger(value.value);
      else {
        overflow = false;
        step(value.value);
      }
    },
    value(): SqliteStoredNumber | null {
      if (count === 0) return null;
      if (!approximate) return { kind: "integer", value: integer };
      if (overflow) throw new RangeError("integer overflow");
      const value = Number.isFinite(error) ? total + error : total;
      return Number.isNaN(value) ? null : { kind: "real", value };
    },
  };
}
