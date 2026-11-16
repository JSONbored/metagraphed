import type { PgStoreRuntime } from "./pg-store-runtime.ts";
import type { PgSql } from "./pg-sql.ts";
import { sqliteNumberDecimal } from "./sqlite-number.ts";

// These aliases are the numeric outputs of the existing identity/key/block
// handlers. Opaque credentials and account strings are deliberately absent.
const numericOutputs = new Set([
  "id",
  "account_id",
  "owner_id",
  "github_user_id",
  "created_at",
  "last_login_at",
  "revoked_at",
  "revocation_requested_at",
  "last_used_at",
  "blocked_at",
  "unblocked_at",
]);

/** Preserve the D1 boundary: finite JS number binds denote their exact binary64
 * value, and numeric result fields cross the handler boundary as JS numbers.
 * Each statement commits before returning, so external key-provider work never
 * holds this lease and durable revocation intent cannot be rolled back later. */
export function createPgAccountIdentitySql(
  runtime: Pick<PgStoreRuntime, "transaction">,
): PgSql {
  const query = <Row>(text: string, values: unknown[] = []): Promise<Row[]> => {
    const parameters = values.map((value) =>
      typeof value === "number" ? sqliteNumberDecimal(value) : value,
    );
    return runtime.transaction(
      async (tx) => {
        await tx.run("SET LOCAL search_path = pg_catalog, app, pg_temp");
        const rows = await tx.query<Row>(text, parameters);
        return rows.map((row) => {
          if (row === null || typeof row !== "object" || Array.isArray(row))
            throw new TypeError("Invalid native account row");
          return Object.fromEntries(
            Object.entries(row).map(([key, value]) => {
              if (!numericOutputs.has(key) || value === null)
                return [key, value];
              const converted = Number(value);
              if (!Number.isFinite(converted))
                throw new TypeError(
                  `Invalid native account numeric field: ${key}`,
                );
              return [key, converted];
            }),
          ) as Row;
        });
      },
      { isolation: "read committed" },
    );
  };
  return Object.assign(
    <Row>(strings: TemplateStringsArray, ...values: unknown[]) =>
      query<Row>(
        strings.reduce((text, part, index) => {
          if (index === 0) return part;
          const value = values[index - 1];
          const cast =
            typeof value !== "number"
              ? ""
              : Number.isInteger(value) &&
                  value >= -(2 ** 63) &&
                  value < 2 ** 63
                ? "::bigint"
                : "::numeric";
          return text + `($${index}${cast})` + part;
        }, ""),
        values,
      ),
    { unsafe: query },
  );
}
