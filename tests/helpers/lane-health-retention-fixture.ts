import { readFileSync, readdirSync } from "node:fs";

const candidates = readdirSync(
  new URL("../../migrations/d1/", import.meta.url),
).filter((name) =>
  /^\d{4}_lane_health_retention_trigger_bounds\.sql$/.test(name),
);
if (candidates.length !== 1)
  throw new Error("Exactly one tracked health trigger repair is required");
export const HEALTH_RETENTION_MIGRATION = candidates[0]!;

// Existing regressions execute the canonical migration, without a second SQL copy.
export function healthRetentionTestSql(name: string): string {
  return readFileSync(
    new URL(
      name === "retention-trigger-repair.sql"
        ? `../../migrations/d1/${HEALTH_RETENTION_MIGRATION}`
        : `../../migrations/d1/${name}`,
      import.meta.url,
    ),
    "utf8",
  );
}
