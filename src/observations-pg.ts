import type { PgStoreRuntime } from "./pg-store-runtime.ts";
import type { ObservationsSql } from "./observations-neon.ts";

/** Reuse the observation writers under one schema-scoped process lease. */
export function createPgObservations(
  runtime: Pick<PgStoreRuntime, "transaction">,
): ObservationsSql {
  const transaction = (run: (sql: ObservationsSql) => Promise<unknown>) =>
    runtime.transaction(async (scope) => {
      await scope.run("SET LOCAL search_path = pg_catalog, app, pg_temp");
      return run({
        nativePostgres: true,
        unsafe: scope.query,
        async nativeFailureRollup(days, runAt) {
          for (const { date, start, end } of days) {
            const groups = await scope.query<Record<string, unknown>>(
              "SELECT netuid,kind,classification,COUNT(*) AS checks FROM surface_checks " +
                "WHERE checked_at >= $1 AND checked_at < $2 AND kind IS NOT NULL AND classification IS NOT NULL " +
                "GROUP BY netuid,kind,classification ORDER BY netuid ASC NULLS FIRST,kind,classification",
              [start, end],
            );
            // NULL and -1 share the source expression key. Ordered individual
            // upserts avoid updating one PostgreSQL target twice in a statement.
            for (const group of groups) {
              await scope.query(
                "INSERT INTO surface_failure_daily(day,netuid,kind,classification,checks,updated_at) VALUES($1,$2,$3,$4,$5,$6) " +
                  "ON CONFLICT(day,(COALESCE(netuid,-1)),kind,classification) DO UPDATE SET checks=excluded.checks,updated_at=excluded.updated_at",
                [
                  date,
                  group.netuid,
                  group.kind,
                  group.classification,
                  group.checks,
                  runAt,
                ],
              );
            }
          }
        },
      });
    });
  return {
    nativePostgres: true,
    transaction,
    unsafe: (text, values) =>
      transaction((scope) => scope.unsafe(text, values)),
  };
}
