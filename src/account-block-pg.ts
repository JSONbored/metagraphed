import type { PgStoreRuntime } from "./pg-store-runtime.ts";
import type { AccountBlockStore } from "./account-block-store.ts";
import { evaluateBlock } from "./api-key-abuse.ts";
import { sqliteNumberDecimal } from "./sqlite-number.ts";

/** Missing/expired cache snapshots must not expire a durable account block. */
export function createPgAccountBlocks(
  runtime: Pick<PgStoreRuntime, "transaction">,
): AccountBlockStore {
  return {
    async read(accountId, accountKind) {
      if (!Number.isInteger(accountId) || accountId <= 0)
        return evaluateBlock(null, accountId, accountKind);
      return runtime.transaction(
        async (tx) => {
          const row = await tx.first<{ reason_code: string }>(
            "SELECT reason_code FROM app.api_key_blocks WHERE account_kind=? AND " +
              (Number.isSafeInteger(accountId)
                ? "account_id=?::numeric"
                : "account_id::double precision=?::double precision") +
              " AND unblocked_at IS NULL ORDER BY account_id LIMIT 1",
            [accountKind, sqliteNumberDecimal(accountId)],
          );
          return evaluateBlock(
            row
              ? {
                  blocks: [
                    { accountId, accountKind, reasonCode: row.reason_code },
                  ],
                }
              : null,
            accountId,
            accountKind,
          );
        },
        { isolation: "read committed" },
      );
    },
  };
}
