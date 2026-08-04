// Tests for scripts/validate-migrations.ts's sequence rule.
//
// The case that matters most is `0001`. Before this rule changed, that was the
// ONLY number this validator accepted — and apply-migrations.ts silently skips
// it, because the live schema_migrations table already records 0001-0044 from
// the D1-era bootstrap. CI green, PR merged, table never created. That is not
// hypothetical: apply-migrations.ts's own header documents three incidents
// (#5348/#5353) where a missing table surfaced as a production 502.

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
