import type { ApiKeyUsageDaily } from "../generated/db/types.ts";
import type { PgStoreRuntime } from "./pg-store-runtime.ts";
import { createSqliteSum, sqliteAggregateNumber } from "./sqlite-sum.ts";
import { sqliteNumberDecimal } from "./sqlite-number.ts";

// These are generated storage rows crossing D1's JSON boundary, where a
// non-finite number becomes null. Derive the keys and storage types first;
// this mapping changes only the named numeric cells at that boundary.
type D1JsonNumbers<Row, Numbers extends keyof Row> = {
  [Key in keyof Row]: Key extends Numbers ? Row[Key] | null : Row[Key];
};
export type AccountUsageRow = D1JsonNumbers<
  Pick<ApiKeyUsageDaily, "day" | "route" | "request_count" | "rejected_count">,
  "request_count" | "rejected_count"
>;
export type AccountAnomalyRow = D1JsonNumbers<
  Pick<ApiKeyUsageDaily, "account_id" | "day" | "route" | "request_count">,
  "request_count"
>;
export interface AccountRollupRow {
  route_family?: string;
  cost_shape: string;
  request_count: number | null;
  keyed_count: number | null;
}

interface StoredAccountUsage {
  day: string;
  route: string;
  requests: string;
  rejected: string;
}
interface StoredRollup {
  route_family: string;
  cost_shape: string;
  requests: string;
  keyed: string;
}

// D1's JSON result boundary represents SQLite infinities as null. Keep that
// conversion before the existing handlers apply their Number(...) coercion.
function wireNumber(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

/** Preserve the source's scan order at each SQL/JS aggregation boundary.
 * PostgreSQL SUM(numeric) is not SQLite SUM(INTEGER/REAL); the typed source
 * counters cross that boundary only after their original ordered reduction. */
export function createPgAccountUsageReaders(
  runtime: Pick<PgStoreRuntime, "transaction">,
) {
  return {
    accountRows(accountId: number, since: string): Promise<AccountUsageRow[]> {
      return runtime.transaction(
        async (tx) => {
          const rows = await tx.query<StoredAccountUsage>(
            "SELECT day,route,request_count::text AS requests,rejected_count::text AS rejected FROM app.api_key_usage_daily WHERE account_id=?::numeric AND day>=? ORDER BY day DESC,source_row_id",
            [sqliteNumberDecimal(accountId), since],
          );
          return rows.map((row) => ({
            day: row.day,
            route: row.route,
            request_count: wireNumber(Number(row.requests)),
            rejected_count: wireNumber(Number(row.rejected)),
          }));
        },
        { isolation: "read committed" },
      );
    },
    anomalyRows(since: string): Promise<AccountAnomalyRow[]> {
      return runtime.transaction(
        async (tx) => {
          const rows = await tx.query<
            Pick<StoredAccountUsage, "day" | "route" | "requests"> & {
              account: string;
            }
          >(
            "SELECT account_id::text AS account,day,route,request_count::text AS requests FROM app.api_key_usage_daily WHERE day>=? ORDER BY account_id,day,source_row_id",
            [since],
          );
          return rows.map((row) => ({
            account_id: Number(row.account),
            day: row.day,
            route: row.route,
            request_count: wireNumber(Number(row.requests)),
          }));
        },
        { isolation: "read committed" },
      );
    },
    rollupRows(
      since: string,
      groupBy: "family" | "shape",
    ): Promise<AccountRollupRow[]> {
      return runtime.transaction(
        async (tx) => {
          const shape = groupBy === "shape";
          const rows = await tx.query<StoredRollup>(
            "SELECT route_family,cost_shape,request_count::text AS requests,keyed_count::text AS keyed FROM app.api_usage_rollup WHERE day>=? ORDER BY " +
              (shape
                ? "cost_shape,day DESC,source_row_id"
                : "route_family,cost_shape,day DESC"),
            [since],
          );
          const groups = new Map<
            string,
            {
              row: StoredRollup;
              requests: ReturnType<typeof createSqliteSum>;
              keyed: ReturnType<typeof createSqliteSum>;
            }
          >();
          for (const row of rows) {
            const key = JSON.stringify(
              shape ? [row.cost_shape] : [row.route_family, row.cost_shape],
            );
            let group = groups.get(key);
            if (!group) {
              group = {
                row,
                requests: createSqliteSum(),
                keyed: createSqliteSum(),
              };
              groups.set(key, group);
            }
            group.requests.add(sqliteAggregateNumber(row.requests));
            group.keyed.add(sqliteAggregateNumber(row.keyed));
          }
          const values = [...groups.values()].map((group) => ({
            ...group,
            requests: group.requests.value(),
            keyed: group.keyed.value(),
          }));
          values.sort((a, b) => {
            if (a.requests === null) return b.requests === null ? 0 : 1;
            if (b.requests === null) return -1;
            return a.requests.value > b.requests.value
              ? -1
              : a.requests.value < b.requests.value
                ? 1
                : 0;
          });
          return (shape ? values : values.slice(0, 500)).map((group) => ({
            ...(shape ? {} : { route_family: group.row.route_family }),
            cost_shape: group.row.cost_shape,
            request_count:
              group.requests === null
                ? null
                : wireNumber(Number(group.requests.value)),
            keyed_count:
              group.keyed === null
                ? null
                : wireNumber(Number(group.keyed.value)),
          }));
        },
        { isolation: "read committed" },
      );
    },
  };
}
