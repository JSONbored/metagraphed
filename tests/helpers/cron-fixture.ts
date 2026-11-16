import { readFileSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import {
  createPgCronScheduler,
  type NativeCronDefinition,
  type NativeCronLimits,
} from "../../src/pg-cron.ts";
import { toPositionalPlaceholders } from "../../src/pg-sql.ts";
import type { PgTransactionRunner } from "../../src/pg-pool.ts";

export const cronMigration = readFileSync(
  new URL("../../migrations/postgres/0030_cron.sql", import.meta.url),
  "utf8",
);
export const cronDefinitions: readonly NativeCronDefinition[] = [
  { owner: "api", cron: "* * * * *" },
];
export const cronLimits: NativeCronLimits = {
  maxConcurrent: 2,
  leaseMilliseconds: 60000,
  executionTimeoutMillis: 30000,
  drainTimeoutMillis: 1000,
  maxAttempts: 3,
  historyLimit: 2,
};
export async function cronFixture(
  db: PGlite,
  definitions = cronDefinitions,
  limits = cronLimits,
) {
  await db.exec("DROP SCHEMA IF EXISTS jobs CASCADE");
  await db.exec(cronMigration);
  const transaction: PgTransactionRunner = (callback) =>
    db.transaction(async (tx) => {
      const query = async <Row>(text: string, values: unknown[] = []) =>
        (await tx.query<Row>(toPositionalPlaceholders(text), values)).rows;
      return callback({
        query,
        first: async <Row>(text: string, values?: unknown[]) =>
          (await query<Row>(text, values))[0] ?? null,
        run: async (text, values = []) => ({
          changes:
            (await tx.query(toPositionalPlaceholders(text), values))
              .affectedRows ?? 0,
        }),
      });
    });
  const runtime = {
    transaction,
    close: async () => {
      throw new Error("Scheduler must not close the pool");
    },
  };
  const scheduler = await createPgCronScheduler(runtime, definitions, limits);
  return { scheduler, runtime, definitions, limits };
}
