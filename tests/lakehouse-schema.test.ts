// The lakehouse's generated types, and what the snapshot boundary means
// (#10315).
//
// The four Iceberg tables were the only store here whose schema generated
// nothing: `schemas-src/` produces `ApiSchema<>`, `generated/db/schema.json`
// produces a row interface per Neon table, and the lakehouse produced a
// convention. Every producer built rows against it from memory -- the Rust
// decoder by hand, and every ad-hoc projector likewise.
//
// The check that did exist fired at the worst possible moment: `iceberg_load.py`
// reads column types off the live table and casts incoming rows to them, INSIDE
// the append. A decoder that renames a column compiles, tests, runs, produces
// rows, and fails at the irreversible step.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "vitest";
import { repoRoot } from "../scripts/lib.ts";
import {
  emitTypes,
  readSnapshot,
  SNAPSHOT_PATH,
  TYPES_PATH,
  type LakehouseColumn,
} from "../scripts/generate-lakehouse-types.ts";
import {
  ACCOUNT_EVENTS_COLUMNS,
  BLOCKS_COLUMNS,
  LAKEHOUSE_TABLES,
} from "../generated/lakehouse/types.ts";

const snapshot = readSnapshot();

describe("the committed snapshot", () => {
  test("covers the four tables the decoder appends to", () => {
    // Named rather than derived from the file: the file is what could be
    // wrong. #10315's whole subject is the four-table ground truth.
    assert.deepEqual([...new Set(snapshot.map((c) => c.table))].sort(), [
      "account_events",
      "blocks",
      "chain_events",
      "extrinsics",
    ]);
    assert.deepEqual([...LAKEHOUSE_TABLES].sort(), [
      "account_events",
      "blocks",
      "chain_events",
      "extrinsics",
    ]);
  });

  test("every column carries a field id, and ids are unique per table", () => {
    // Field id is Iceberg's identity for a column -- a rename keeps the id, so
    // it is what makes "the same column" answerable at all.
    for (const table of LAKEHOUSE_TABLES) {
      const ids = snapshot
        .filter((c) => c.table === table)
        .map((c) => c.field_id);
      assert.ok(ids.length > 0, `${table} has no columns`);
      assert.equal(new Set(ids).size, ids.length, `${table} has duplicate ids`);
    }
  });

  test("account_events carries the eleven columns a projector must write", () => {
    // The list I hand-typed for the PrometheusServed backfill, which is the
    // concrete case this artifact exists to remove.
    assert.deepEqual(
      [...ACCOUNT_EVENTS_COLUMNS],
      [
        "block_number",
        "event_index",
        "extrinsic_index",
        "event_kind",
        "hotkey",
        "coldkey",
        "netuid",
        "uid",
        "amount_tao",
        "alpha_amount",
        "observed_at",
      ],
    );
  });
});

describe("emitTypes", () => {
  test("the committed artifact is exactly what the snapshot produces", () => {
    // The same assertion validate:lakehouse-types-drift makes in CI; having it
    // here too means a stale artifact fails the unit suite rather than only the
    // pipeline, which is where a contributor sees it first.
    assert.equal(
      readFileSync(path.join(repoRoot, TYPES_PATH), "utf8"),
      emitTypes(snapshot),
    );
  });

  test("is deterministic", () => {
    assert.equal(emitTypes(snapshot), emitTypes(snapshot));
  });

  test("orders each column tuple by FIELD ID, not alphabetically", () => {
    // The order the loader appends in, so a hand-built positional row matches.
    // Alphabetical would put `author` before `block_number` and read as
    // plausible.
    assert.equal(BLOCKS_COLUMNS[0], "block_number");
    const ids = snapshot
      .filter((c) => c.table === "blocks")
      .sort((a, b) => a.field_id - b.field_id)
      .map((c) => c.column);
    assert.deepEqual([...BLOCKS_COLUMNS], ids);
  });

  test("an unmapped Iceberg type THROWS rather than defaulting", () => {
    // The failure mode worth designing against: a new Iceberg type silently
    // becoming `unknown` or `any` would generate a file that compiles and
    // describes nothing, which is worse than no artifact.
    const poisoned: LakehouseColumn[] = [
      ...snapshot,
      {
        table: "blocks",
        field_id: 9999,
        column: "when",
        type: "timestamptz",
        required: false,
      },
    ];
    assert.throws(() => emitTypes(poisoned), /unmapped Iceberg type/);
  });

  test("a non-required column is nullable, a required one is not", () => {
    const out = emitTypes([
      {
        table: "t",
        field_id: 1,
        column: "a",
        type: "long",
        required: true,
      },
      {
        table: "t",
        field_id: 2,
        column: "b",
        type: "string",
        required: false,
      },
    ]);
    assert.match(out, /a: number;/);
    assert.match(out, /b: string \| null;/);
  });
});

describe("the snapshot boundary", () => {
  test("the snapshot path is committed, so a PR is judged against a file", () => {
    // Deliberate: the drift validator needs no credential and therefore runs on
    // every PR. Whether the LAKEHOUSE has moved is a different question, and
    // scripts/refresh-lakehouse-schema.ts answers it out of band with
    // R2_CATALOG_TOKEN -- the same split generate-db-types.ts uses for Neon.
    assert.ok(
      readFileSync(path.join(repoRoot, SNAPSHOT_PATH), "utf8").length > 0,
    );
  });
});
