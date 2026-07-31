// Tests for scripts/validate-migrations.ts's sequence rule.
//
// The case that matters most is `0001`. Before this rule changed, that was the
// ONLY number this validator accepted — and apply-migrations.ts silently skips
// it, because the live schema_migrations table already records 0001-0044 from
// the D1-era bootstrap. CI green, PR merged, table never created. That is not
// hypothetical: apply-migrations.ts's own header documents three incidents
// (#5348/#5353) where a missing table surfaced as a production 502.

import { describe, expect, it } from "vitest";
import {
  migrationSequenceErrors,
  RETIRED_D1_WATERMARK,
} from "../scripts/validate-migrations.ts";

describe("the retired-D1 watermark", () => {
  it("rejects a prefix the live database already records as applied", () => {
    const errors = migrationSequenceErrors(["0001_foo.sql"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("skip it silently");
    // The message must name the number to use, not just the problem.
    expect(errors[0]).toContain("0045");
  });

  it("rejects the watermark itself, not just below it", () => {
    expect(
      migrationSequenceErrors([`00${RETIRED_D1_WATERMARK}_foo.sql`]),
    ).toHaveLength(1);
  });

  it("accepts the first prefix above the watermark", () => {
    expect(
      migrationSequenceErrors([
        `00${RETIRED_D1_WATERMARK + 1}_emission_gate_history.sql`,
      ]),
    ).toEqual([]);
  });
});

describe("sequencing", () => {
  it("accepts consecutive prefixes above the watermark", () => {
    expect(
      migrationSequenceErrors(["0045_a.sql", "0046_b.sql", "0047_c.sql"]),
    ).toEqual([]);
  });

  it("still rejects a gap", () => {
    const errors = migrationSequenceErrors(["0045_a.sql", "0047_b.sql"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("expected 0046");
  });

  it("still rejects a duplicate prefix", () => {
    // The original bug: 0007_neurons and 0007_latency_percentiles shipped
    // together and desynced name-keyed migration tracking.
    const errors = migrationSequenceErrors(["0045_a.sql", "0045_b.sql"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("duplicate migration prefix 0045");
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
