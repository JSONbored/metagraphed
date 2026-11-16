import type { PgSql } from "./pg-sql.ts";

export interface SelfHealthTick {
  component: string;
  checkedAt: number;
  day: string;
  ok: boolean;
  http_status: number | null;
  latency_ms: number | null;
}
export interface NativeSelfHealthStore {
  sql: PgSql;
  record(tick: SelfHealthTick): Promise<void>;
}

export function selectedNativeSelfHealthStore(
  env: unknown,
): NativeSelfHealthStore | null {
  if (!env || typeof env !== "object" || !("SELF_HEALTH_STORE" in env))
    return null;
  const store = env.SELF_HEALTH_STORE;
  if (
    !store ||
    typeof store !== "object" ||
    !("sql" in store) ||
    typeof store.sql !== "function" ||
    !("unsafe" in store.sql) ||
    typeof store.sql.unsafe !== "function" ||
    !("record" in store) ||
    typeof store.record !== "function"
  )
    throw new TypeError("Native self-health capability is incomplete");
  return store as NativeSelfHealthStore;
}
