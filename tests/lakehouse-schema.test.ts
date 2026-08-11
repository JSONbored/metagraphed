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
  DECODER_TABLES,
  emitRustTypes,
  emitTypes,
  readSnapshot,
  SNAPSHOT_PATH,
  RUST_PATH,
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
  test("covers every chain.* table this repo reads", () => {
    // Named rather than derived from the file: the file is what could be
    // wrong. The four the decoder appends to, plus the nine the cold tiers
    // read -- the set was four until the readers were included, which left
    // ten queried tables with no snapshot and no drift coverage.
    //
    // account_events_daily is NOT here on purpose: it is named in four
    // comments and a route description and queried by nothing, because
    // src/account-history-cold-tier.ts computes its own day bucket from
    // account_events instead.
    //
    // neuron_daily and account_position_daily joined the list in #10794/#10797:
    // they were a frozen 2026-08-02 seed holding a strict SUBSET of Neon until
    // metagraphed-infra#445 gave them a producer, and src/neuron-daily-cold-
    // tier.ts now reads them below the retention seam. The list grows when a
    // READER appears, which is the rule refresh-lakehouse-schema.ts states.
    assert.deepEqual([...new Set(snapshot.map((c) => c.table))].sort(), [
      "account_events",
      "account_identity",
      "account_identity_history",
      "account_position_daily",
      "blocks",
      "chain_events",
      "extrinsics",
      "neuron_daily",
      "nominator_positions",
      "rpc_proxy_events",
      "self_health_daily",
      "subnet_hyperparams",
      "subnet_hyperparams_history",
      "subnet_identity_history",
      "subnet_ownership_history",
    ]);
    // The TS side mirrors the snapshot -- it is the READER's list.
    assert.deepEqual(
      [...LAKEHOUSE_TABLES].sort(),
      [...new Set(snapshot.map((c) => c.table))].sort(),
    );
  });

  test("the Rust side covers only the tables the decoder writes", () => {
    // THE TWO SIDES ARE DIFFERENT SETS. The snapshot spans what this repo
    // reads; the decoder writes four of them. A producer struct for
    // self_health_daily would assert a write that has never happened.
    assert.deepEqual([...DECODER_TABLES].sort(), [
      "account_events",
      "blocks",
      "chain_events",
      "extrinsics",
    ]);
    const snapshotTables = new Set(snapshot.map((c) => c.table));
    for (const t of DECODER_TABLES) {
      assert.ok(
        snapshotTables.has(t),
        `${t} is emitted as a producer struct but has no snapshot to emit from`,
      );
    }
    const rust = readFileSync(path.join(repoRoot, RUST_PATH), "utf8");
    for (const t of snapshotTables) {
      const struct = `pub struct ${t
        .split("_")
        .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
        .join("")}Row`;
      assert.equal(
        rust.includes(struct),
        DECODER_TABLES.includes(t),
        `${t}: producer struct presence must match DECODER_TABLES`,
      );
    }
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

// The producer half (#10315). The decoder that WRITES these tables builds its
// rows as `serde_json::json!({ "hotkey": …, … })`, so a column rename is caught
// by iceberg_load.py's cast inside the append rather than by the compiler. A
// struct whose field names ARE the columns moves that to compile time.
describe("emitRustTypes", () => {
  const columns = [
    { table: "t", field_id: 2, column: "b", type: "string", required: false },
    { table: "t", field_id: 1, column: "a", type: "long", required: false },
  ];

  test("emits one struct per table, fields in FIELD-ID order", () => {
    const out = emitRustTypes(columns, ["t"]);
    assert.match(out, /pub struct TRow \{/);
    // serde preserves declaration order, so this order IS the append order.
    assert.ok(
      out.indexOf("pub a:") < out.indexOf("pub b:"),
      "field_id 1 must precede field_id 2",
    );
  });

  test("maps Iceberg primitives to Rust, Option for every non-required column", () => {
    const out = emitRustTypes(columns, ["t"]);
    assert.match(out, /pub a: Option<i64>,/);
    assert.match(out, /pub b: Option<String>,/);
  });

  test("a required column is not wrapped in Option", () => {
    const out = emitRustTypes(
      [{ table: "t", field_id: 1, column: "a", type: "int", required: true }],
      ["t"],
    );
    assert.match(out, /pub a: i32,/);
  });

  // The same refusal emitTypes makes: an unmapped type must stop the build
  // rather than fall back to something plausible.
  test("throws on an Iceberg type it has no Rust mapping for", () => {
    assert.throws(
      () =>
        emitRustTypes(
          [
            {
              table: "t",
              field_id: 1,
              column: "a",
              type: "timestamptz",
              required: false,
            },
          ],
          ["t"],
        ),
      /unmapped Iceberg type/,
    );
  });

  test("the column constant is sized and ordered like the struct", () => {
    const out = emitRustTypes(columns, ["t"]);
    assert.match(
      out,
      /pub const T_COLUMNS: \[&str; 2\] = \[\n {4}"a",\n {4}"b",\n\];/,
    );
  });

  test("the committed artifact is what the committed snapshot produces", () => {
    assert.equal(
      readFileSync(path.join(repoRoot, RUST_PATH), "utf8"),
      emitRustTypes(readSnapshot()),
    );
  });
});
