import type { PgStoreRuntime } from "./pg-store-runtime.ts";
import type { AccountStateStore } from "./account-state-store.ts";
import { createPgAccountIdentitySql } from "./account-identity-pg.ts";
import { createPgAccountUsage } from "./account-usage-pg.ts";
import { createPgAccountUsageReaders } from "./account-usage-read-pg.ts";
import { createPgAccountBlocks } from "./account-block-pg.ts";
import { createPgDailyQuota } from "./pg-daily-quota.ts";

/** One shared process pool owns the complete account family. A partial family
 * is not a deployment option; selecting it must not revive another backend. */
export function createNativeAccountState(
  runtime: Pick<PgStoreRuntime, "transaction">,
): AccountStateStore {
  return {
    sql: createPgAccountIdentitySql(runtime),
    usage: {
      ...createPgAccountUsage(runtime),
      ...createPgAccountUsageReaders(runtime),
    },
    quota: createPgDailyQuota(runtime),
    blocks: createPgAccountBlocks(runtime),
  };
}
