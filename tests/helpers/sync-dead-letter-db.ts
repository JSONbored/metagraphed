import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

export function syncDeadLetterDb() {
  const sql = new DatabaseSync(":memory:");
  sql.exec(
    readFileSync(
      new URL(
        "../../migrations/d1/0025_sync_dead_letters.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const db = {
    prepare(text: string) {
      return {
        bind(...values: (string | number)[]) {
          return {
            async first() {
              return sql.prepare(text).get(...values) ?? null;
            },
          };
        },
      };
    },
  } as unknown as Pick<D1Database, "prepare">;
  return { sql, db };
}
