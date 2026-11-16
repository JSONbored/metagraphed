import { readFileSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import type { PgTransactionRunner } from "../../src/pg-pool.ts";
import { toPositionalPlaceholders } from "../../src/pg-sql.ts";
import { createPgChainFirehoseStore } from "../../src/pg-chain-firehose-store.ts";

export const chainStateLimits = {
  maxStateBytes: 131072,
  leaseMilliseconds: 60000,
};
export const chainMigration = readFileSync(
  new URL(
    "../../migrations/postgres/0034_chain_firehose_actor.sql",
    import.meta.url,
  ),
  "utf8",
);
export async function chainFixture(db: PGlite) {
  await db.exec("DROP SCHEMA IF EXISTS realtime CASCADE");
  await db.exec(chainMigration);
  let active = 0;
  const transaction: PgTransactionRunner = (callback) =>
    db.transaction(async (tx) => {
      active++;
      const query = async <Row>(text: string, values: unknown[] = []) =>
        (await tx.query<Row>(toPositionalPlaceholders(text), values)).rows;
      try {
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
        active--;
      }
    });
  const runtime = { transaction };
  const store = await createPgChainFirehoseStore(runtime, chainStateLimits);
  return { runtime, store, activeTransactions: () => active };
}
