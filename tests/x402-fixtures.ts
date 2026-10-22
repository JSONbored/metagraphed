import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createX402AttemptStore } from "../src/x402-attempt-store.ts";

/** Real migrated payment state for protocol/router tests; close after use. */
export function createX402Fixture() {
  const sql = new DatabaseSync(":memory:");
  sql.exec(
    readFileSync(
      new URL("../migrations/d1/0039_x402_payment_attempts.sql", import.meta.url),
      "utf8",
    ),
  );
  const prepare = (text: string, values: unknown[] = []) => ({
    bind(...next: unknown[]) {
      return prepare(text, next);
    },
    async first() {
      const row = sql.prepare(text).get(...(values as never[]));
      return row ? { ...row } : null;
    },
  });
  const db = {
    prepare,
    withSession: () => ({ prepare }),
  } as unknown as D1Database;
  return { db, sql, store: createX402AttemptStore(db)!, close: () => sql.close() };
}
