import { readFileSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import {
  createPgQueueTransport,
  type PgQueueLimits,
  type PgQueueName,
} from "../../src/pg-queue.ts";
import { toPositionalPlaceholders } from "../../src/pg-sql.ts";
import type { PgTransactionRunner } from "../../src/pg-pool.ts";

export const queueMigration = readFileSync(
  new URL("../../migrations/postgres/0026_jobs.sql", import.meta.url),
  "utf8",
);
export async function queueFixture(
  db: PGlite,
  limits: PgQueueLimits = {
    maxMessages: 1000,
    maxBytes: 1000000,
    leaseMilliseconds: 60000,
    executionTimeoutMillis: 30000,
    drainTimeoutMillis: 1000,
  },
) {
  await db.exec("DROP SCHEMA IF EXISTS jobs CASCADE");
  await db.exec(queueMigration);
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
      throw new Error("Transport must not close the pool");
    },
  };
  const transport = await createPgQueueTransport(runtime, limits);
  const flush = (queue: PgQueueName) =>
    db.query(
      "UPDATE jobs.messages SET available_at_ms=available_at_ms-60000 WHERE queue=$1",
      [queue],
    );
  return { transport, runtime, limits, flush };
}
export function queueDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
