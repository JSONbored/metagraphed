// Tests for scripts/validate-migrations.ts's sequence rule.
//
// The rule guards migrations/d1, and `0001` is legal there. It was NOT legal under
// Postgres: the live schema_migrations table recorded 0001-0044, so a file numbered
// below that was silently skipped by the migration runner — CI green, PR merged, table
// never created, surfacing later as a production 502 (#5348/#5353, three incidents).
//
// Postgres is gone (#9426) and wrangler consults no version table, so the floor went
// with the reason for it. What survives is the part that always mattered, and it matters
// MORE now: D1 migrations are applied BY HAND, so nothing else would catch a duplicate.

import { describe, expect, it } from "vitest";
import { migrationSequenceErrors } from "../scripts/validate-migrations.ts";

describe("sequencing", () => {
  it("accepts consecutive prefixes", () => {
    expect(
      migrationSequenceErrors(["0001_a.sql", "0002_b.sql", "0003_c.sql"]),
    ).toEqual([]);
  });

  it("still rejects a gap", () => {
    const errors = migrationSequenceErrors(["0001_a.sql", "0003_b.sql"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("expected 0002");
  });

  it("still rejects a duplicate prefix", () => {
    // The original bug: 0007_neurons and 0007_latency_percentiles shipped
    // together and desynced name-keyed migration tracking.
    const errors = migrationSequenceErrors(["0001_a.sql", "0001_b.sql"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("duplicate migration prefix 0001");
  });

  it("is order-independent — the caller's listing order cannot change the verdict", () => {
    expect(migrationSequenceErrors(["0046_b.sql", "0045_a.sql"])).toEqual([]);
  });

  it("rejects a malformed name", () => {
    const errors = migrationSequenceErrors(["not-a-migration.sql"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("NNNN_snake_case.sql");
  });

  it("passes on an empty directory", () => {
    // The current state: #6477 deleted all 81 D1 files, #6486 kept the dir.
    expect(migrationSequenceErrors([])).toEqual([]);
  });
});
