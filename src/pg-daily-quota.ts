import { asAccountKind } from "./account-kind.ts";
import { applyQuotaSpend, utcDayKey } from "./daily-quota.ts";
import type { DailyQuotaStore } from "./daily-quota-store.ts";
import type { PgKvRuntime } from "./pg-kv.ts";
import {
  sqliteAddNumbers,
  sqliteIntegerAffinity,
  sqliteNumberDecimal,
  sqliteStoredNumber,
  sqliteStoredNumberText,
} from "./sqlite-number.ts";

/** The composite-key D1 UPSERT applies INTEGER affinity before its conflict
 * path. Preserve exact INTEGER arithmetic, REAL/overflow arithmetic and the
 * separate existing wire conversion. Numeric scale retains source kind. */
export function createPgDailyQuota(
  runtime: Pick<PgKvRuntime, "transaction">,
): DailyQuotaStore {
  return {
    async spend({ accountId, accountKind, cost, limit, nowMs }) {
      if (
        !Number.isInteger(accountId) ||
        accountId <= 0 ||
        !asAccountKind(accountKind) ||
        !Number.isFinite(cost) ||
        cost < 0 ||
        !Number.isFinite(limit) ||
        limit <= 0
      ) {
        throw new TypeError("Invalid daily quota input");
      }
      const day = utcDayKey(nowMs);
      if (cost > limit) return applyQuotaSpend(0, cost, limit, nowMs);
      const account = sqliteNumberDecimal(accountId);
      return runtime.transaction(
        async (tx) => {
          await tx.run("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
          await tx.query<{ pg_advisory_xact_lock: null }>(
            "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(?,0))",
            [
              JSON.stringify([
                "metagraphed:daily-quota",
                accountKind,
                account,
                day,
              ]),
            ],
          );
          const current = await tx.first<{ used: string }>(
            "SELECT units_spent::text AS used FROM app.api_quota_daily WHERE account_kind=? AND account_id=?::numeric AND day=? FOR UPDATE",
            [accountKind, account, day],
          );
          const used =
            current === null
              ? { kind: "integer" as const, value: 0n }
              : sqliteStoredNumber(current.used);
          const operand = sqliteIntegerAffinity(cost);
          const next = sqliteAddNumbers(used, operand);
          if (next.value <= limit) {
            await tx.run(
              "INSERT INTO app.api_quota_daily(account_kind,account_id,day,units_spent,updated_at) VALUES (?,?::numeric,?,?::numeric,?) " +
                "ON CONFLICT(account_kind,account_id,day) DO UPDATE SET units_spent=excluded.units_spent,updated_at=excluded.updated_at",
              [accountKind, account, day, sqliteStoredNumberText(next), nowMs],
            );
            return applyQuotaSpend(
              Number(next.value) - cost,
              cost,
              limit,
              nowMs,
            );
          }
          return applyQuotaSpend(Number(used.value), cost, limit, nowMs);
        },
        { isolation: "read committed" },
      );
    },
  };
}
