import { readFileSync } from "node:fs";

// This prospective repair is disposable test input, never an active migration.
// Stage two promotes these exact bytes to0039 under separate DDL approval.
export function healthRetentionTestSql(name: string): string {
  return readFileSync(
    new URL(
      name === "retention-trigger-repair.sql"
        ? "../fixtures/lane-health-retention-trigger-bounds.sql"
        : `../../migrations/d1/${name}`,
      import.meta.url,
    ),
    "utf8",
  );
}
