import { createHash, randomUUID } from "node:crypto";
import type { AccountKind } from "./account-kind.ts";
import type { PgStoreRuntime } from "./pg-store-runtime.ts";
import type { PgTransaction } from "./pg-pool.ts";
import type { UsageRollupBucket } from "./usage-rollup-d1.ts";
import {
  sqliteAddNumbers,
  sqliteIntegerAffinity,
  sqliteNumberDecimal,
} from "./sqlite-number.ts";
import {
  createSqliteSum,
  sqliteAggregateNumber,
  sqliteAggregateText,
  sqliteJsonNumber,
} from "./sqlite-sum.ts";

const empty = { kind: "integer" as const, value: 0n };

function connectionFailure(error: unknown): boolean {
  if (
    error instanceof Error &&
    [
      "Connection terminated unexpectedly",
      "Connection terminated",
      "Client has encountered a connection error and is not queryable",
      "timeout exceeded when trying to connect",
    ].includes(error.message)
  )
    return true;
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = error.code;
  return (
    typeof code === "string" &&
    (/^08[0-9A-Z]{3}$/.test(code) ||
      [
        "ECONNRESET",
        "ECONNABORTED",
        "EPIPE",
        "ETIMEDOUT",
        "ECONNREFUSED",
        "ENETUNREACH",
        "EHOSTUNREACH",
        "57P01",
        "57P02",
        "57P03",
      ].includes(code))
  );
}

async function lock(tx: PgTransaction, key: readonly unknown[]) {
  await tx.query<{ pg_advisory_xact_lock: null }>(
    "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(?,0))",
    [JSON.stringify(key)],
  );
}

/** Usage writes keep the source INTEGER/REAL operations inside one pool-owned
 * transaction. This factory selects no Worker path or production source. */
export function createPgAccountUsage(
  runtime: Pick<PgStoreRuntime, "transaction">,
) {
  return {
    async increment(input: {
      accountKind: AccountKind;
      accountId: number;
      day: string;
      route: string;
      rejected: boolean;
    }): Promise<void> {
      const account = sqliteNumberDecimal(input.accountId);
      await runtime.transaction(
        async (tx) => {
          await lock(tx, [
            "account-usage",
            input.accountKind,
            account,
            input.day,
            input.route,
          ]);
          const current = await tx.first<{
            requests: string;
            rejected: string;
          }>(
            "SELECT request_count::text AS requests,rejected_count::text AS rejected FROM app.api_key_usage_daily WHERE account_kind=? AND account_id=?::numeric AND day=? AND route=? FOR UPDATE",
            [input.accountKind, account, input.day, input.route],
          );
          const requests = sqliteAddNumbers(
            current ? sqliteAggregateNumber(current.requests) : empty,
            sqliteIntegerAffinity(input.rejected ? 0 : 1),
          );
          const rejected = sqliteAddNumbers(
            current ? sqliteAggregateNumber(current.rejected) : empty,
            sqliteIntegerAffinity(input.rejected ? 1 : 0),
          );
          await tx.run(
            "INSERT INTO app.api_key_usage_daily(account_kind,account_id,day,route,request_count,rejected_count) VALUES (?,?::numeric,?,?,?::numeric,?::numeric) ON CONFLICT(account_kind,account_id,day,route) DO UPDATE SET request_count=excluded.request_count,rejected_count=excluded.rejected_count",
            [
              input.accountKind,
              account,
              input.day,
              input.route,
              sqliteAggregateText(requests),
              sqliteAggregateText(rejected),
            ],
          );
        },
        { isolation: "read committed" },
      );
    },

    async writeRollup(
      buckets: readonly UsageRollupBucket[],
      deps: { batchId?: string; now?: () => number } = {},
    ): Promise<void> {
      if (buckets.length === 0) return;
      const payload = JSON.stringify(buckets);
      if (Buffer.byteLength(payload) > 2 * 1024 * 1024)
        throw new RangeError("Usage batch exceeds the source TEXT budget");
      const groups = new Map<
        string,
        {
          bucket: UsageRollupBucket;
          requests: ReturnType<typeof createSqliteSum>;
          keyed: ReturnType<typeof createSqliteSum>;
        }
      >();
      for (const bucket of buckets) {
        const key = JSON.stringify([
          bucket.day,
          bucket.family,
          bucket.cost_shape,
        ]);
        let group = groups.get(key);
        if (!group) {
          group = {
            bucket,
            requests: createSqliteSum(),
            keyed: createSqliteSum(),
          };
          groups.set(key, group);
        }
        group.requests.add(sqliteJsonNumber(bucket.request_count));
        group.keyed.add(sqliteJsonNumber(bucket.keyed_count));
      }
      const values = [...groups.values()]
        .sort(
          (a, b) =>
            Buffer.compare(
              Buffer.from(a.bucket.day),
              Buffer.from(b.bucket.day),
            ) ||
            Buffer.compare(
              Buffer.from(a.bucket.family),
              Buffer.from(b.bucket.family),
            ) ||
            Buffer.compare(
              Buffer.from(a.bucket.cost_shape),
              Buffer.from(b.bucket.cost_shape),
            ),
        )
        .map((group) => ({
          ...group.bucket,
          requests: sqliteAggregateText(group.requests.value()),
          keyed: sqliteAggregateText(group.keyed.value()),
        }));
      const batchId = deps.batchId ?? randomUUID();
      const digest = createHash("sha256").update(payload).digest("hex");
      const expiresAt = (deps.now ?? Date.now)() + 600_000;
      const apply = () =>
        runtime.transaction(
          async (tx) => {
            await lock(tx, ["usage-batch", batchId]);
            const clock = await tx.first<{ now: string }>(
              "SELECT floor(extract(epoch FROM pg_catalog.clock_timestamp())*1000)::bigint::text AS now",
            );
            const now = Number(clock?.now);
            if (!Number.isSafeInteger(now))
              throw new Error("Invalid native usage clock");
            await tx.run(
              "WITH expired AS (SELECT batch_id FROM app.api_usage_rollup_batches WHERE expires_at<? ORDER BY expires_at LIMIT 200 FOR UPDATE SKIP LOCKED) DELETE FROM app.api_usage_rollup_batches target USING expired WHERE target.batch_id=expired.batch_id",
              [now],
            );
            await tx.run(
              "INSERT INTO app.api_usage_rollup_batches(batch_id,sha256,expires_at,applied) SELECT ?,?,?,false WHERE ?::bigint>=?::bigint ON CONFLICT(batch_id) DO NOTHING",
              [batchId, digest, expiresAt, expiresAt, now],
            );
            const receipt = await tx.first<{
              sha256: string;
              applied: boolean;
              expires_at: string;
            }>(
              "SELECT sha256,applied,expires_at::text FROM app.api_usage_rollup_batches WHERE batch_id=? FOR UPDATE",
              [batchId],
            );
            if (!receipt || receipt.sha256 !== digest)
              throw new Error("Usage rollup batch was not acknowledged");
            if (receipt.applied) return;
            if (Number(receipt.expires_at) < now)
              throw new Error("Usage rollup batch expired");
            for (const value of values) {
              await lock(tx, [
                "usage-rollup",
                value.day,
                value.family,
                value.cost_shape,
              ]);
              const current = await tx.first<{
                requests: string;
                keyed: string;
              }>(
                "SELECT request_count::text AS requests,keyed_count::text AS keyed FROM app.api_usage_rollup WHERE day=? AND route_family=? AND cost_shape=? FOR UPDATE",
                [value.day, value.family, value.cost_shape],
              );
              const requests = current
                ? sqliteAddNumbers(
                    sqliteAggregateNumber(current.requests),
                    sqliteAggregateNumber(value.requests),
                  )
                : sqliteAggregateNumber(value.requests);
              const keyed = current
                ? sqliteAddNumbers(
                    sqliteAggregateNumber(current.keyed),
                    sqliteAggregateNumber(value.keyed),
                  )
                : sqliteAggregateNumber(value.keyed);
              await tx.run(
                "INSERT INTO app.api_usage_rollup(day,route_family,cost_shape,request_count,keyed_count) VALUES (?,?,?,?::numeric,?::numeric) ON CONFLICT(day,route_family,cost_shape) DO UPDATE SET request_count=excluded.request_count,keyed_count=excluded.keyed_count",
                [
                  value.day,
                  value.family,
                  value.cost_shape,
                  sqliteAggregateText(requests),
                  sqliteAggregateText(keyed),
                ],
              );
            }
            await tx.run(
              "UPDATE app.api_usage_rollup_batches SET applied=true WHERE batch_id=?",
              [batchId],
            );
          },
          { isolation: "read committed" },
        );
      try {
        await apply();
      } catch (error) {
        // This receipt-guarded operation is safe even when COMMIT succeeded
        // but its reply was lost. Every retry keeps the original ID, payload
        // hash and expiry; other account mutations never retry implicitly.
        if (!connectionFailure(error)) throw error;
        await new Promise((resolve) =>
          setTimeout(resolve, 250 + Math.floor(Math.random() * 250)),
        );
        await apply();
      }
    },
  };
}
