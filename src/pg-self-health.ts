import type { PgStoreRuntime } from "./pg-store-runtime.ts";
import type { NativeSelfHealthStore } from "./native-self-health-store.ts";
import { pgStatementText, type PgSql } from "./pg-sql.ts";

/** Preserve D1's atomic tick/daily contribution and duplicate retry behavior. */
export function createPgSelfHealthStore(
  runtime: Pick<PgStoreRuntime, "transaction">,
): NativeSelfHealthStore {
  const read = <Row>(text: string, values?: unknown[]) =>
    runtime.transaction(
      async (transaction) => {
        await transaction.run(
          "SET LOCAL search_path = pg_catalog, app, pg_temp",
        );
        return transaction.query<Row>(text, values);
      },
      { isolation: "read committed" },
    );
  const sql: PgSql = Object.assign(
    <Row>(strings: TemplateStringsArray, ...values: unknown[]) =>
      read<Row>(pgStatementText(strings), values),
    { unsafe: read },
  );
  return {
    sql,
    record: (tick) =>
      runtime.transaction(
        async (transaction) => {
          const inserted = await transaction.query<{ component: string }>(
            `INSERT INTO app.self_health_checks(component,checked_at_ms,ok,http_status,latency_ms)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(component,checked_at_ms) DO NOTHING RETURNING component`,
            [
              tick.component,
              tick.checkedAt,
              tick.ok,
              tick.http_status,
              tick.latency_ms,
            ],
          );
          if (inserted.length)
            await transaction.run(
              `INSERT INTO app.self_health_daily(day,component,checks,ok_count) VALUES($1,$2,1,$3)
        ON CONFLICT(day,component) DO UPDATE SET checks=self_health_daily.checks+1,
          ok_count=self_health_daily.ok_count+excluded.ok_count`,
              [tick.day, tick.component, Number(tick.ok)],
            );
          const stored = await transaction.first<{ present: boolean }>(
            "SELECT EXISTS(SELECT 1 FROM app.self_health_checks WHERE component=$1 AND checked_at_ms=$2) AS present",
            [tick.component, tick.checkedAt],
          );
          if (stored?.present !== true)
            throw new Error("Native self-health tick was not acknowledged");
        },
        { isolation: "read committed" },
      ),
  };
}
