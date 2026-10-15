import { readFileSync } from "node:fs";

// Exercise the canonical stage-two migration; production application is separate.
export function healthRetentionTestSql(name: string): string {
  return readFileSync(
    new URL(
      name === "retention-trigger-repair.sql"
        ? "../../migrations/d1/0039_lane_health_retention_trigger_bounds.sql"
        : `../../migrations/d1/${name}`,
      import.meta.url,
    ),
    "utf8",
  );
}
