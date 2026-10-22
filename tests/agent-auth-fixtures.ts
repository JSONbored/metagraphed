import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createAgentAuthStore } from "../src/agent-auth-store.ts";

/** Real migrated private state; a batch either commits every statement or none. */
export function createAgentAuthFixture(
  options: { migrated?: boolean; session?: boolean } = {},
) {
  const sql = new DatabaseSync(":memory:");
  sql.exec("PRAGMA foreign_keys=ON");
  sql.exec(
    readFileSync(
      new URL("../migrations/d1/0005_user_state.sql", import.meta.url),
      "utf8",
    ),
  );
  sql.exec(
    "INSERT INTO github_accounts(id,github_user_id,github_login,created_at) VALUES(42,4200,'owner',0)",
  );
  if (options.migrated !== false) {
    const migration = readFileSync(
      new URL("../migrations/d1/0040_agent_auth.sql", import.meta.url),
      "utf8",
    );
    for (const statement of migration.split("-- statement-breakpoint")) {
      if (statement.trim()) sql.prepare(statement).run();
    }
  }
  let before: ((query: string) => void) | undefined;
  const sessions: string[] = [];
  const prepare = (query: string, values: unknown[] = []) => ({
    query,
    values,
    bind(...next: unknown[]) {
      return prepare(query, next);
    },
    async first() {
      before?.(query);
      const row = sql.prepare(query).get(...(values as never[]));
      return row ? { ...row } : null;
    },
  });
  const binding = {
    prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
      sql.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map(({ query, values }) => {
          before?.(query);
          return {
            success: true,
            results: sql
              .prepare(query)
              .all(...(values as never[]))
              .map((row) => ({ ...row })),
          };
        });
        sql.exec("COMMIT");
        return results;
      } catch (error) {
        sql.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const db = (options.session === false
    ? binding
    : {
        ...binding,
        withSession(hint: string) {
          sessions.push(hint);
          return binding;
        },
      }) as unknown as D1Database;
  return {
    sql,
    db,
    sessions,
    store: createAgentAuthStore(db)!,
    before(fn?: (query: string) => void) {
      before = fn;
    },
    close: () => sql.close(),
  };
}
