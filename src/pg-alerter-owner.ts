import { randomUUID } from "node:crypto";
import type { PgStoreRuntime } from "./pg-store-runtime.ts";
import type { PgTransaction } from "./pg-pool.ts";

export interface AlerterOwnerLease {
  token: string;
  nowMs: number;
  expiresAtMs: number;
}
interface OwnerRow {
  owner_token: string | null;
  lease_until_ms: string | number;
}

/** The global evaluator lease never retains a connection during delivery. */
export async function createPgAlerterOwner(
  runtime: Pick<PgStoreRuntime, "transaction">,
  leaseMilliseconds: number,
) {
  if (
    !Number.isSafeInteger(leaseMilliseconds) ||
    leaseMilliseconds < 1 ||
    leaseMilliseconds > 3600000
  )
    throw new RangeError("Invalid alerter lease duration");
  const transaction = <T>(
    operation: (tx: PgTransaction, row: OwnerRow, now: number) => Promise<T>,
  ) =>
    runtime.transaction(
      async (tx) => {
        const row = await tx.first<OwnerRow>(
          "SELECT owner_token,lease_until_ms FROM realtime.alerter_owner WHERE singleton FOR UPDATE",
        );
        const clock = await tx.first<{ now: string | number }>(
          "SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now",
        );
        const now = Number(clock?.now);
        if (
          !row ||
          !Number.isSafeInteger(now) ||
          now < 0 ||
          !Number.isSafeInteger(Number(row.lease_until_ms))
        )
          throw new Error("Invalid native alerter ownership state");
        return operation(tx, row, now);
      },
      { isolation: "read committed" },
    );
  await runtime.transaction(
    async (tx) => {
      await tx.run(
        "INSERT INTO realtime.alerter_owner(singleton) VALUES(true) ON CONFLICT(singleton) DO NOTHING",
      );
    },
    { isolation: "read committed" },
  );
  return {
    acquire(): Promise<AlerterOwnerLease | null> {
      return transaction(async (tx, row, now) => {
        if (row.owner_token !== null && Number(row.lease_until_ms) > now)
          return null;
        const token = randomUUID(),
          expiresAtMs = now + leaseMilliseconds;
        await tx.run(
          "UPDATE realtime.alerter_owner SET owner_token=?::uuid,lease_until_ms=? WHERE singleton",
          [token, expiresAtMs],
        );
        return { token, nowMs: now, expiresAtMs };
      });
    },
    renew(lease: AlerterOwnerLease): Promise<AlerterOwnerLease> {
      return transaction(async (tx, row, now) => {
        if (
          row.owner_token !== lease.token ||
          Number(row.lease_until_ms) <= now
        )
          throw new Error("Native alerter ownership was lost");
        const expiresAtMs = now + leaseMilliseconds;
        await tx.run(
          "UPDATE realtime.alerter_owner SET lease_until_ms=? WHERE singleton AND owner_token=?::uuid",
          [expiresAtMs, lease.token],
        );
        return { token: lease.token, nowMs: now, expiresAtMs };
      });
    },
    async release(lease: AlerterOwnerLease): Promise<void> {
      await runtime.transaction(
        async (tx) => {
          await tx.run(
            "UPDATE realtime.alerter_owner SET owner_token=NULL,lease_until_ms=0 WHERE singleton AND owner_token=?::uuid",
            [lease.token],
          );
        },
        { isolation: "read committed" },
      );
    },
  };
}
