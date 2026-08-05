// The subnet-hyperparams + account-identity D1 write paths (the #9157
// pattern applied to the last two Postgres-only sync lanes), exercised
// against a REAL SQLite database loaded with the REAL migration
// (migrations/d1/0009_hyperparams_identity.sql) -- same rationale as
// tests/data-api-neurons-d1.test.ts: the riskiest constructs (multi-row
// guarded upserts, the literal-interpolated NOT IN prune, append-only
// history inserts) only fail at execution, and no fake parses SQL.
//
// Also carries 0009's schema-vs-writer correspondence checks, both
// directions, mirroring tests/neurons-d1-schema.test.ts's anti-drift
// guarantee: a column the writer sends but the table lacks makes D1 reject
// the whole batch; a column the table has but the writer never sends is a
// permanently-NULL field that reads like real data.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { beforeEach, describe, test } from "vitest";
import {
  ACCOUNT_IDENTITY_HISTORY_COLUMNS,
  SUBNET_HYPERPARAMS_HISTORY_COLUMNS,
  buildHyperparamsPrune,
  writeAccountIdentityToD1,
  writeSubnetHyperparamsToD1,
} from "../src/hyperparams-identity-d1-write.ts";
import {
  buildAppendInsert,
  D1_PARAM_BUDGET,
  rowsPerStatement,
} from "../src/neurons-d1-write.ts";
import { SUBNET_HYPERPARAMS_INSERT_COLUMNS } from "../src/subnet-hyperparams.ts";
import {
  ACCOUNT_IDENTITY_INSERT_COLUMNS,
  IDENTITY_FIELDS,
} from "../src/account-identity.ts";
import type { Row } from "./row-type.ts";

const MIGRATION = readFileSync(
  path.join(process.cwd(), "migrations/d1/0009_hyperparams_identity.sql"),
  "utf8",
);

/** Column names of one CREATE TABLE block, in declaration order (the same
 * parser tests/neurons-d1-schema.test.ts uses against 0007). */
function tableColumns(table: string): string[] {
  const match = MIGRATION.match(
    new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`),
  );
  assert.ok(match, `no CREATE TABLE for ${table} in the migration`);
  return match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line &&
        !line.startsWith("--") &&
        !line.startsWith("PRIMARY KEY") &&
        !line.startsWith("CHECK"),
    )
    .map((line) => line.split(/\s+/)[0]);
}

describe("the 0009 schema matches its writer, both directions", () => {
  test("the migration parser actually finds columns", () => {
    assert.ok(
      tableColumns("subnet_hyperparams").length >= 30,
      `expected the hyperparams columns, found ${tableColumns("subnet_hyperparams").length}`,
    );
  });

  test("subnet_hyperparams holds exactly the columns the sync binds", () => {
    assert.deepEqual(
      tableColumns("subnet_hyperparams").sort(),
      [...SUBNET_HYPERPARAMS_INSERT_COLUMNS].sort(),
    );
  });

  test("subnet_hyperparams_history is the writer's history list plus its id", () => {
    assert.deepEqual(
      tableColumns("subnet_hyperparams_history").sort(),
      ["id", ...SUBNET_HYPERPARAMS_HISTORY_COLUMNS].sort(),
    );
  });

  test("account_identity holds exactly the columns the sync binds", () => {
    assert.deepEqual(
      tableColumns("account_identity").sort(),
      [...ACCOUNT_IDENTITY_INSERT_COLUMNS].sort(),
    );
  });

  test("account_identity_history is the writer's history list plus its id", () => {
    assert.deepEqual(
      tableColumns("account_identity_history").sort(),
      ["id", ...ACCOUNT_IDENTITY_HISTORY_COLUMNS].sort(),
    );
  });

  test("the upsert keys are declared as primary keys", () => {
    // ON CONFLICT (...) requires a matching uniqueness constraint; without it
    // SQLite raises and every sync fails.
    for (const key of ["PRIMARY KEY (netuid)", "PRIMARY KEY (account)"]) {
      assert.ok(MIGRATION.includes(key), `missing ${key}`);
    }
    // The histories' only key is the AUTOINCREMENT id -- append-only, and the
    // (observed_at, id) keyset cursor relies on ids never being reused.
    assert.equal(
      (MIGRATION.match(/^\s*id\s+INTEGER PRIMARY KEY AUTOINCREMENT/gm) ?? [])
        .length,
      2,
      "both history tables need an AUTOINCREMENT id",
    );
  });

  test("every column set fits the Workers-binding parameter budget", () => {
    // The binding caps a statement at 100 bound parameters (#9173); the chunk
    // size is derived from the column count so this can never silently break.
    for (const columns of [
      SUBNET_HYPERPARAMS_INSERT_COLUMNS,
      SUBNET_HYPERPARAMS_HISTORY_COLUMNS,
      ACCOUNT_IDENTITY_INSERT_COLUMNS,
      ACCOUNT_IDENTITY_HISTORY_COLUMNS,
    ]) {
      const per = rowsPerStatement(columns.length);
      assert.ok(per >= 1);
      assert.ok(
        per * columns.length <= D1_PARAM_BUDGET,
        `${columns.length} columns x ${per} rows exceeds the budget`,
      );
    }
  });

  test("an append insert carries no conflict clause", () => {
    // The histories are append-only: an upsert clause here would silently
    // turn revisions into overwrites.
    const sql = buildAppendInsert(
      "subnet_hyperparams_history",
      SUBNET_HYPERPARAMS_HISTORY_COLUMNS,
      2,
    );
    assert.ok(!sql.includes("ON CONFLICT"));
    assert.equal((sql.match(/\(\?/g) ?? []).length, 2);
  });
});

// --- execution against real SQLite -----------------------------------------

let db: InstanceType<typeof DatabaseSync>;

/** Real D1 converts boolean binds to INTEGER 1/0; node:sqlite rejects them
 * outright, so the fake applies the platform's documented conversion. */
function d1Bind(value: unknown): unknown {
  if (value === true) return 1;
  if (value === false) return 0;
  return value;
}

function d1() {
  const prepared: { text: string; values: unknown[] }[] = [];
  return {
    prepared,
    prepare(text: string) {
      return {
        bind(...values: unknown[]) {
          const entry = { text, values: values.map(d1Bind) };
          prepared.push(entry);
          return entry;
        },
      };
    },
    async batch(statements: { text: string; values: unknown[] }[]) {
      db.exec("BEGIN");
      try {
        const results = statements.map((statement) => ({
          results: db
            .prepare(statement.text)
            .all(...(statement.values as never[])),
        }));
        db.exec("COMMIT");
        return results;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  };
}

type Db = Parameters<typeof writeSubnetHyperparamsToD1>[0];

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(MIGRATION);
});

const one = (sql: string, ...params: unknown[]) =>
  db.prepare(sql).get(...(params as never[])) as Row;
const count = (table: string) =>
  (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;

/** A coerced latest-only hyperparams row, the shape the handler passes in
 * (booleans already real booleans -- coerceSubnetHyperparamsSyncRow ran). */
function hyperparamsRow(overrides: Row = {}): Row {
  const row: Row = {};
  for (const column of SUBNET_HYPERPARAMS_INSERT_COLUMNS) row[column] = null;
  return {
    ...row,
    netuid: 8,
    kappa_ratio: 0.5,
    tempo: 360,
    registration_allowed: true,
    commit_reveal_enabled: false,
    weights_rate_limit: 100,
    block_number: 5_000_000,
    captured_at: 1_780_000_000_000,
    ...overrides,
  };
}

function historyRow(overrides: Row = {}): Row {
  const row: Row = {};
  for (const column of SUBNET_HYPERPARAMS_HISTORY_COLUMNS) row[column] = null;
  return {
    ...row,
    netuid: 8,
    observed_at: 1_780_000_000_000,
    hyperparams_hash: "hash-a",
    ...overrides,
  };
}

function identityRow(overrides: Row = {}): Row {
  const row: Row = {};
  for (const column of ACCOUNT_IDENTITY_INSERT_COLUMNS) row[column] = null;
  return {
    ...row,
    account: "5Alice",
    name: "Alice",
    captured_at: 1_780_000_000_000,
    ...overrides,
  };
}

function identityHistoryRow(overrides: Row = {}): Row {
  const row: Row = {};
  for (const column of ACCOUNT_IDENTITY_HISTORY_COLUMNS) row[column] = null;
  return {
    ...row,
    account: "5Alice",
    observed_at: 1_780_000_000_000,
    identity_hash: "ihash-a",
    ...overrides,
  };
}

describe("writeSubnetHyperparamsToD1 against real SQLite", () => {
  test("upserts the latest-only table, booleans stored as 0/1", async () => {
    await writeSubnetHyperparamsToD1(d1() as unknown as Db, {
      rows: [hyperparamsRow()],
      netuids: [8],
      historyRows: [historyRow()],
    });
    const row = one("SELECT * FROM subnet_hyperparams WHERE netuid = 8");
    assert.equal(row.tempo, 360);
    assert.equal(row.registration_allowed, 1);
    assert.equal(row.commit_reveal_enabled, 0);
    assert.equal(count("subnet_hyperparams_history"), 1);
  });

  test("a newer capture refreshes every column; an older one is a no-op", async () => {
    const database = d1() as unknown as Db;
    await writeSubnetHyperparamsToD1(database, {
      rows: [hyperparamsRow()],
      netuids: [8],
      historyRows: [],
    });
    await writeSubnetHyperparamsToD1(database, {
      rows: [hyperparamsRow({ tempo: 99, captured_at: 1_780_000_000_001 })],
      netuids: [8],
      historyRows: [],
    });
    assert.equal(
      one("SELECT tempo FROM subnet_hyperparams WHERE netuid = 8").tempo,
      99,
    );
    // A replayed, older batch must never regress a newer row.
    await writeSubnetHyperparamsToD1(database, {
      rows: [hyperparamsRow({ tempo: 1, captured_at: 1_779_000_000_000 })],
      netuids: [8],
      historyRows: [],
    });
    assert.equal(
      one("SELECT tempo FROM subnet_hyperparams WHERE netuid = 8").tempo,
      99,
    );
    assert.equal(count("subnet_hyperparams"), 1);
  });

  test("prunes netuids the batch no longer covers, keeping their history", async () => {
    const database = d1() as unknown as Db;
    await writeSubnetHyperparamsToD1(database, {
      rows: [hyperparamsRow({ netuid: 8 }), hyperparamsRow({ netuid: 9 })],
      netuids: [8, 9],
      historyRows: [historyRow({ netuid: 9 })],
    });
    await writeSubnetHyperparamsToD1(database, {
      rows: [hyperparamsRow({ netuid: 8, captured_at: 1_780_000_000_001 })],
      netuids: [8],
      historyRows: [],
    });
    assert.equal(count("subnet_hyperparams"), 1);
    assert.equal(
      one("SELECT netuid FROM subnet_hyperparams").netuid,
      8,
      "the covered netuid survives; the absent one is deregistered",
    );
    // The prune is a latest-only concern -- history is an audit trail.
    assert.equal(count("subnet_hyperparams_history"), 1);
  });

  test("history appends are append-only with increasing ids", async () => {
    const database = d1() as unknown as Db;
    await writeSubnetHyperparamsToD1(database, {
      rows: [hyperparamsRow()],
      netuids: [8],
      historyRows: [historyRow({ hyperparams_hash: "hash-a" })],
    });
    await writeSubnetHyperparamsToD1(database, {
      rows: [hyperparamsRow({ captured_at: 1_780_000_000_001 })],
      netuids: [8],
      historyRows: [historyRow({ hyperparams_hash: "hash-b" })],
    });
    const rows = db
      .prepare(
        "SELECT id, hyperparams_hash FROM subnet_hyperparams_history ORDER BY id",
      )
      .all() as Row[];
    assert.equal(rows.length, 2);
    assert.ok((rows[1].id as number) > (rows[0].id as number));
    assert.deepEqual(
      rows.map((row) => row.hyperparams_hash),
      ["hash-a", "hash-b"],
    );
  });

  test("the prune interpolates literals, binding nothing", async () => {
    // A full production batch is ~129 netuids and the Workers binding caps a
    // statement at 100 bound parameters -- a bound NOT IN would fail exactly
    // at production scale. Literals keep the statement at zero binds.
    const netuids = Array.from({ length: 129 }, (_, i) => i);
    const sql = buildHyperparamsPrune(netuids);
    assert.ok(!sql.includes("?"));
    assert.ok(sql.includes("NOT IN (0, 1, 2"));
    const database = d1();
    await writeSubnetHyperparamsToD1(database as unknown as Db, {
      rows: [],
      netuids,
      historyRows: [],
    });
    const prune = database.prepared.find((s) => s.text.startsWith("DELETE"));
    assert.ok(prune);
    assert.equal(prune.values.length, 0);
  });

  test("the prune refuses to interpolate a non-integer netuid", () => {
    // The guard is the module's own, independent of handler validation --
    // interpolation without it would be an injection surface.
    assert.throws(() => buildHyperparamsPrune([8, 1.5]));
    assert.throws(() =>
      buildHyperparamsPrune([8, "9; DROP TABLE" as unknown as number]),
    );
    assert.throws(() => buildHyperparamsPrune([-1]));
  });

  test("an empty batch touches the database not at all", async () => {
    const database = d1();
    const result = await writeSubnetHyperparamsToD1(database as unknown as Db, {
      rows: [],
      netuids: [],
      historyRows: [],
    });
    assert.equal(result.statements, 0);
    assert.equal(database.prepared.length, 0);
  });
});

describe("writeAccountIdentityToD1 against real SQLite", () => {
  test("upserts latest-only and appends history, with NO prune", async () => {
    const database = d1() as unknown as Db;
    await writeAccountIdentityToD1(database, {
      rows: [identityRow({ account: "5Alice" })],
      historyRows: [identityHistoryRow({ account: "5Alice" })],
    });
    // A later batch covering a DIFFERENT account must not delete the first:
    // an identity is a property of the owning account, not of appearing in
    // every snapshot pass.
    await writeAccountIdentityToD1(database, {
      rows: [identityRow({ account: "5Bob", name: "Bob" })],
      historyRows: [
        identityHistoryRow({ account: "5Bob", identity_hash: "ihash-b" }),
      ],
    });
    assert.equal(count("account_identity"), 2);
    assert.equal(count("account_identity_history"), 2);
  });

  test("the staleness guard holds on the account key", async () => {
    const database = d1() as unknown as Db;
    await writeAccountIdentityToD1(database, {
      rows: [identityRow({ name: "New", captured_at: 2_000 })],
      historyRows: [],
    });
    await writeAccountIdentityToD1(database, {
      rows: [identityRow({ name: "Old", captured_at: 1_000 })],
      historyRows: [],
    });
    assert.equal(
      one("SELECT name FROM account_identity WHERE account = '5Alice'").name,
      "New",
    );
  });

  test("a full-width batch is ONE statement, and every row still lands", async () => {
    // The old shape: 9 columns against the 90-parameter budget is 10 rows a
    // statement, so 25 accounts took 3. They now take one -- and this runs
    // against REAL SQLite, so it is also the end-to-end proof that the
    // json_each upsert writes what the per-row binding wrote.
    const rows = Array.from({ length: 25 }, (_, i) =>
      identityRow({ account: `5Acct${i}` }),
    );
    const database = d1();
    await writeAccountIdentityToD1(database as unknown as Db, {
      rows,
      historyRows: [],
    });
    assert.equal(database.prepared.length, 1);
    for (const statement of database.prepared) {
      assert.equal(statement.values.length, 1, "one parameter per statement");
    }
    assert.equal(count("account_identity"), 25, "every row landed");
    // The parameter budget still describes the OLD shape correctly; it is just
    // no longer what bounds a chunk.
    assert.equal(
      rowsPerStatement(ACCOUNT_IDENTITY_INSERT_COLUMNS.length) *
        ACCOUNT_IDENTITY_INSERT_COLUMNS.length,
      90,
    );
  });

  test("an empty batch touches the database not at all", async () => {
    const database = d1();
    const result = await writeAccountIdentityToD1(database as unknown as Db, {
      rows: [],
      historyRows: [],
    });
    assert.equal(result.statements, 0);
    assert.equal(database.prepared.length, 0);
  });

  test("history rows bind every identity field in column order", async () => {
    const fields = Object.fromEntries(
      IDENTITY_FIELDS.map((field, i) => [field, `v${i}`]),
    );
    await writeAccountIdentityToD1(d1() as unknown as Db, {
      rows: [],
      historyRows: [identityHistoryRow(fields)],
    });
    const row = one("SELECT * FROM account_identity_history");
    for (const [i, field] of IDENTITY_FIELDS.entries()) {
      assert.equal(row[field], `v${i}`, `${field} bound out of order`);
    }
  });
});
