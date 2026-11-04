import { readFileSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import type { PgTransactionRunner } from "../../src/pg-pool.ts";
import { toPositionalPlaceholders } from "../../src/pg-sql.ts";
import {
  createPgSubnetStatusHub,
  type NativeSubnetStatusOptions,
} from "../../src/pg-subnet-status-hub.ts";

export const subnetStatusMigration = readFileSync(
  new URL(
    "../../migrations/postgres/0031_subnet_status_actor.sql",
    import.meta.url,
  ),
  "utf8",
);
export const subnetStatusOptions: NativeSubnetStatusOptions = {
  maxConcurrentRequests: 4,
  maxRequestBytes: 8192,
  maxStateBytes: 131072,
  maxMemberships: 1000,
  notificationConcurrency: 2,
  executionTimeoutMillis: 30000,
  drainTimeoutMillis: 1000,
  notify: async () => {},
  onBackgroundError: () => {},
};
export async function subnetStatusFixture(
  db: PGlite,
  options = subnetStatusOptions,
) {
  await db.exec("DROP SCHEMA IF EXISTS realtime CASCADE");
  await db.exec(subnetStatusMigration);
  let activeTransactions = 0;
  const transaction: PgTransactionRunner = (callback) =>
    db.transaction(async (tx) => {
      activeTransactions++;
      try {
        const query = async <Row>(text: string, values: unknown[] = []) =>
          (await tx.query<Row>(toPositionalPlaceholders(text), values)).rows;
        return await callback({
          query,
          first: async <Row>(text: string, values?: unknown[]) =>
            (await query<Row>(text, values))[0] ?? null,
          run: async (text, values = []) => ({
            changes:
              (await tx.query(toPositionalPlaceholders(text), values))
                .affectedRows ?? 0,
          }),
        });
      } finally {
        activeTransactions--;
      }
    });
  const runtime = {
    transaction,
    close: async () => {
      throw new Error("Actor must not close the shared pool");
    },
  };
  const hub = await createPgSubnetStatusHub(runtime, options);
  return {
    hub,
    runtime,
    options,
    activeTransactions: () => activeTransactions,
  };
}
