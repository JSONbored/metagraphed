// The lakehouse freshness rule, tested without a catalog (#11048).
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  EXPECTED,
  evaluate,
  typeChangedAcrossSchemas,
} from "../scripts/check-lakehouse-freshness.ts";
import { TABLES } from "../scripts/refresh-lakehouse-schema.ts";

const DAY = 24 * 60 * 60 * 1000;

describe("lakehouse freshness", () => {
  test("an UNCLASSIFIED table fails -- absent is not exempt", () => {
    // The Neon watchdog's rule, for the Neon watchdog's reason: absent means
    // nobody thought about it, and a table nobody classified is watched by
    // nothing, forever.
    const v = evaluate(
      { table: "brand_new", newestMs: Date.now(), ageMs: 0 },
      undefined,
    );
    assert.equal(v.ok, false);
    assert.match(v.detail, /not classified/);
  });

  test("every table this repo READS is classified", () => {
    // Derived from the snapshot list rather than restated, so a table added
    // there without a bound here fails.
    const unclassified = TABLES.filter((t: string) => !(t in EXPECTED));
    assert.deepEqual(unclassified, []);
  });

  test("a table past its bound is STALE, and says by how much", () => {
    const v = evaluate(
      {
        table: "nominator_positions",
        newestMs: Date.now() - 11 * DAY,
        ageMs: 11 * DAY,
      },
      EXPECTED.nominator_positions,
    );
    assert.equal(v.ok, false);
    assert.match(v.detail, /11\.0d/);
  });

  test("a table inside its bound passes", () => {
    const v = evaluate(
      { table: "blocks", newestMs: Date.now() - 60_000, ageMs: 60_000 },
      EXPECTED.blocks,
    );
    assert.equal(v.ok, true);
  });

  test("NO snapshots at all is a failure, not an age of zero", () => {
    const v = evaluate(
      { table: "blocks", newestMs: null, ageMs: null },
      EXPECTED.blocks,
    );
    assert.equal(v.ok, false);
    assert.match(v.detail, /NO snapshots/);
  });

  test("an explicit null bound is exempt, and carries its reason", () => {
    const v = evaluate(
      { table: "rehearsal", newestMs: 0, ageMs: 99 * DAY },
      EXPECTED.rehearsal,
    );
    assert.equal(v.ok, true);
    assert.match(v.detail, /rehearsal fixture/);
  });

  test("the frozen tables are bounded by what they SHOULD do, not their outage", () => {
    // A watchdog calibrated to the outage it watches reports success forever.
    // These must FAIL at their measured 10.5d age, which is the point.
    for (const t of [
      "nominator_positions",
      "subnet_hyperparams",
      "self_health_daily",
    ]) {
      const rule = EXPECTED[t]!;
      assert.ok(rule.maxAgeMs !== null && rule.maxAgeMs < 10.5 * DAY, t);
    }
  });
});

describe("type changes across schema generations (metagraphed-infra#542)", () => {
  const field = (id: number, name: string, type: string) => ({
    id,
    name,
    type,
  });

  test("a widened column is a candidate", () => {
    // float -> double is legal in Iceberg and unreadable in R2 SQL until the
    // files are rewritten. This is the case that broke chain.neurons.
    const changed = typeChangedAcrossSchemas({
      "current-schema-id": 1,
      schemas: [
        { "schema-id": 0, fields: [field(22, "take", "float")] },
        { "schema-id": 1, fields: [field(22, "take", "double")] },
      ],
    });
    assert.deepEqual(changed, ["take"]);
  });

  test("ADDING a column is not a candidate", () => {
    // R2 SQL tolerates augmentation, so observed_at appearing in a later
    // generation must not be reported -- three registry tables gained exactly
    // that column and none of them broke.
    const changed = typeChangedAcrossSchemas({
      "current-schema-id": 1,
      schemas: [
        { "schema-id": 0, fields: [field(1, "netuid", "int")] },
        {
          "schema-id": 1,
          fields: [field(1, "netuid", "int"), field(2, "observed_at", "long")],
        },
      ],
    });
    assert.deepEqual(changed, []);
  });

  test("a DROPPED column is not a candidate", () => {
    const changed = typeChangedAcrossSchemas({
      "current-schema-id": 1,
      schemas: [
        {
          "schema-id": 0,
          fields: [field(1, "netuid", "int"), field(2, "gone", "string")],
        },
        { "schema-id": 1, fields: [field(1, "netuid", "int")] },
      ],
    });
    assert.deepEqual(changed, []);
  });

  test("a single generation is never a candidate", () => {
    assert.deepEqual(
      typeChangedAcrossSchemas({
        "current-schema-id": 0,
        schemas: [{ "schema-id": 0, fields: [field(1, "a", "int")] }],
      }),
      [],
    );
  });

  test("matching is by FIELD ID, not name", () => {
    // Iceberg identifies a column by id; a rename with the same id is the same
    // column, and two columns sharing a name across generations need not be.
    const changed = typeChangedAcrossSchemas({
      "current-schema-id": 1,
      schemas: [
        { "schema-id": 0, fields: [field(7, "old_name", "int")] },
        { "schema-id": 1, fields: [field(7, "new_name", "long")] },
      ],
    });
    assert.deepEqual(changed, ["new_name"]);
  });

  test("undefined metadata is not a crash", () => {
    assert.deepEqual(typeChangedAcrossSchemas(undefined), []);
  });
});
