import type { AccountKind } from "./account-kind.ts";
import type { QuotaSpendResult } from "./daily-quota.ts";

export interface DailyQuotaInput {
  accountId: number;
  accountKind: AccountKind;
  cost: number;
  limit: number;
  nowMs: number;
}
export interface DailyQuotaStore {
  spend(input: DailyQuotaInput): Promise<QuotaSpendResult>;
}

export function selectedDailyQuotaStore(env: unknown): DailyQuotaStore | null {
  if (!env || typeof env !== "object" || !("DAILY_QUOTA_STORE" in env))
    return null;
  const value = env.DAILY_QUOTA_STORE;
  if (!value || typeof (value as DailyQuotaStore).spend !== "function")
    throw new TypeError("Native daily quota capability is incomplete");
  return value as DailyQuotaStore;
}
