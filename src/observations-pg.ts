import type { PgStoreRuntime } from "./pg-store-runtime.ts";
import type { ObservationsSql } from "./observations-neon.ts";

/** Reuse the observation writers under one schema-scoped process lease. */
export function createPgObservations(
  runtime: Pick<PgStoreRuntime, "transaction">,
): ObservationsSql {
  const transaction = (run: (sql: ObservationsSql) => Promise<unknown>) =>
    runtime.transaction(async (scope) => {
      await scope.run("SET LOCAL search_path = pg_catalog, app, pg_temp");
      return run({ nativePostgres: true, unsafe: scope.query });
    });
  return {
    nativePostgres: true,
    transaction,
    unsafe: (text, values) => transaction((scope) => scope.unsafe(text, values)),
  };
}
