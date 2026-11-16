import { readStore, recordOrNull } from "./read-store.ts";
import {
  pgStatementText,
  toPositionalPlaceholders,
  type PgSql,
} from "./pg-sql.ts";

const families = new Set([
  "surface_status",
  "subnet_hyperparams",
  "subnet_hyperparams_history",
  "account_identity",
  "account_identity_history",
]);
const healthIntegers = [
  "netuid",
  "latency_ms",
  "status_code",
  "last_checked",
  "last_ok",
  "consecutive_failures",
] as const;
type HealthIntegerValues = Partial<
  Record<(typeof healthIntegers)[number], number | string | null>
>;

/** Only these relational handlers have a qualified native SQL shape. A native
 * selection never gives the document-view families a legacy fallback. */
export function selectedNativeRelationalSql(
  env: unknown,
  tables: readonly string[],
): PgSql | undefined | null {
  if (recordOrNull(env)?.NATIVE_READ_STORE === undefined) return null;
  if (!tables.length || !tables.every((table) => families.has(table)))
    return undefined;
  const store = readStore(env, tables)!;
  const query: PgSql["unsafe"] = async <Row>(
    text: string,
    parameters: unknown[] = [],
  ) => {
    let statement = toPositionalPlaceholders(text);
    let values = parameters;
    // D1 compares INTEGER columns to fractional or out-of-int64 public bounds.
    // Native bigint parameter inference would reject those values. Numeric
    // comparison retains the exact integer column and the supplied bound.
    statement = statement.replace(
      /\bWHERE (last_checked >=|netuid =) \$1\b/,
      (_match, predicate: string) => {
        const value = parameters[0];
        if (typeof value !== "number" || !Number.isFinite(value))
          throw new TypeError("Native relational bound must be finite");
        const integer = Number.isInteger(value) ? BigInt(value) : null;
        values = [
          integer === null ? value : integer.toString(),
          ...parameters.slice(1),
        ];
        const type =
          integer !== null && integer >= -(1n << 63n) && integer < 1n << 63n
            ? "bigint"
            : "numeric";
        return `WHERE ${predicate} $1::${type}`;
      },
    );
    // Preserve indexed text equality for ordinary account lookups. The rare
    // NUL or lone-surrogate request uses byte equality because a PostgreSQL
    // text parameter cannot represent it. Persisted text still has to pass
    // the source import's separate admissibility checks.
    const accountPredicate =
      /\bFROM account_identity(?:_history)?\s+WHERE account = \$1\b/;
    if (accountPredicate.test(statement)) {
      if (typeof parameters[0] !== "string")
        throw new TypeError("Native account identity must be text");
      if (/\0|[\uD800-\uDFFF]/u.test(parameters[0])) {
        statement = statement.replace(
          /\bWHERE account = \$1\b/,
          "WHERE convert_to(account,'UTF8') = $1::bytea",
        );
        values = [Buffer.from(parameters[0]), ...parameters.slice(1)];
      }
    }
    const rows = await store.query<Row>(statement, values);
    if (!/\bFROM surface_status\b/.test(statement)) return rows;
    // This route returns raw integer fields; D1 rounds int64 at its JSON wire
    // boundary while pg keeps out-of-safe-range integers as decimal strings.
    return rows.map((row) => {
      const converted: HealthIntegerValues = {};
      for (const name of healthIntegers) {
        const value = (row as HealthIntegerValues)[name];
        if (value != null) converted[name] = Number(value);
      }
      return { ...row, ...converted };
    });
  };
  return Object.assign(
    <Row>(strings: TemplateStringsArray, ...values: unknown[]) =>
      query<Row>(pgStatementText(strings), values),
    { unsafe: query },
  );
}
