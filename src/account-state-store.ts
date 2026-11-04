import type { PgSql } from "./pg-sql.ts";
import type { AccountBlockStore } from "./account-block-store.ts";
import type { DailyQuotaStore } from "./daily-quota-store.ts";
import type { createPgAccountUsage } from "./account-usage-pg.ts";
import type { createPgAccountUsageReaders } from "./account-usage-read-pg.ts";

export interface AccountStateStore {
  sql: PgSql;
  usage: ReturnType<typeof createPgAccountUsage> &
    ReturnType<typeof createPgAccountUsageReaders>;
  quota: DailyQuotaStore;
  blocks: AccountBlockStore;
}

export function selectedAccountStateStore(
  env: unknown,
): AccountStateStore | null {
  if (!env || typeof env !== "object" || !("ACCOUNT_STATE_STORE" in env))
    return null;
  const store = env.ACCOUNT_STATE_STORE;
  if (
    !store ||
    typeof store !== "object" ||
    !("sql" in store) ||
    typeof store.sql !== "function" ||
    !("unsafe" in store.sql) ||
    typeof store.sql.unsafe !== "function" ||
    !("usage" in store) ||
    !store.usage ||
    typeof store.usage !== "object" ||
    !("quota" in store) ||
    !store.quota ||
    typeof store.quota !== "object" ||
    !("spend" in store.quota) ||
    typeof store.quota.spend !== "function" ||
    !("blocks" in store) ||
    !store.blocks ||
    typeof store.blocks !== "object" ||
    !("read" in store.blocks) ||
    typeof store.blocks.read !== "function"
  )
    throw new TypeError("Native account state capability is incomplete");
  for (const method of [
    "increment",
    "writeRollup",
    "accountRows",
    "anomalyRows",
    "rollupRows",
  ])
    if (
      !(method in store.usage) ||
      typeof Reflect.get(store.usage, method) !== "function"
    )
      throw new TypeError("Native account usage capability is incomplete");
  return store as AccountStateStore;
}
