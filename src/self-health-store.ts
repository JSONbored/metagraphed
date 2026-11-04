import { createD1Sql, selectedD1Store } from "./d1-store.ts";
import { canWaitUntil, createPgSql } from "./pg-sql.ts";
import { selectedNativeSelfHealthStore } from "./native-self-health-store.ts";
import { hyperdriveConnectionString } from "./read-store.ts";

export const SELF_HEALTH_TABLES = [
  "self_health_checks",
  "self_health_daily",
] as const;

/** REST, GraphQL, MCP and the producer must use the same complete family. */
export function selfHealthSql(
  env: unknown,
  ctx?: { waitUntil?: (promise: Promise<unknown>) => void } | null,
) {
  const native = selectedNativeSelfHealthStore(env);
  if (native) return native.sql;
  const d1 = selectedD1Store(env, SELF_HEALTH_TABLES);
  if (d1) return createD1Sql(d1);
  const connectionString = hyperdriveConnectionString(env);
  return connectionString && canWaitUntil(ctx)
    ? createPgSql({ connectionString }, ctx)
    : null;
}
