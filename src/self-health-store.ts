import { createD1Sql, selectedD1Store } from "./d1-store.ts";
import { canWaitUntil, createPgSql } from "./pg-sql.ts";

export const SELF_HEALTH_TABLES = [
  "self_health_checks",
  "self_health_daily",
] as const;

/** REST, GraphQL, MCP and the producer must use the same complete family. */
export function selfHealthSql(
  env: { HYPERDRIVE?: { connectionString?: string } } | null | undefined,
  ctx?: { waitUntil?: (promise: Promise<unknown>) => void } | null,
) {
  const d1 = selectedD1Store(env, SELF_HEALTH_TABLES);
  if (d1) return createD1Sql(d1);
  return env?.HYPERDRIVE?.connectionString && canWaitUntil(ctx)
    ? createPgSql({ connectionString: env.HYPERDRIVE.connectionString }, ctx)
    : null;
}
