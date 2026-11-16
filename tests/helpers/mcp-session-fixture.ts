import { readFileSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import type { PgTransactionRunner } from "../../src/pg-pool.ts";
import { toPositionalPlaceholders } from "../../src/pg-sql.ts";
import {
  createPgMcpSessionStore,
  type McpStoreLimits,
} from "../../src/pg-mcp-session-store.ts";

export const mcpMigration = readFileSync(
  new URL("../../migrations/postgres/0032_mcp_sessions.sql", import.meta.url),
  "utf8",
);
export const mcpLimits: McpStoreLimits = {
  maxSessions: 100,
  maxBytes: 1000000,
  maxStateBytes: 131072,
  leaseMilliseconds: 60000,
};
export async function mcpFixture(db: PGlite, limits = mcpLimits) {
  await db.exec("DROP SCHEMA IF EXISTS realtime CASCADE");
  await db.exec(mcpMigration);
  let active = 0;
  const transaction: PgTransactionRunner = (callback) =>
    db.transaction(async (tx) => {
      active++;
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
        active--;
      }
    });
  const runtime = {
    transaction,
    close: async () => {
      throw new Error("MCP session service cannot close its shared pool");
    },
  };
  const store = await createPgMcpSessionStore(runtime, limits);
  return { runtime, store, limits, activeTransactions: () => active };
}
