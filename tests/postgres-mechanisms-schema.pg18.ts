// The mechanism (mechid) dimension in PostgreSQL (#13162; #13161, epic #13142).
//
// 0044 backfills every existing neuron-family row as mechanism 0 (the
// ingestion dedupe makes that the truth, not a guess), rekeys the three tables
// the issue names on (netuid, mechid, ...), and creates app.subnet_mechanisms
// for the per-mechanism registry the engine will fill. The member tables are
// exercised with real inserts; the document tables carry decoder-receipt
// triggers (0024), so their new key is asserted from the catalog instead of
// through a write that would need a staged receipt.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import { Client } from "pg";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";

const control = new Client({
  connectionString: pg18FixtureUrl().toString(),
  connectionTimeoutMillis: 2000,
  statement_timeout: 5000,
});
const migration = (name: string) =>
  readFileSync(
    new URL(`../migrations/postgres/${name}`, import.meta.url),
    "utf8",
  );

async function primaryKeyColumns(table: string): Promise<string[]> {
  const { rows } = await control.query(
    `SELECT a.attname AS column
     FROM pg_constraint c
     JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
     JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
     WHERE c.contype = 'p' AND c.conrelid = ($1)::regclass
     ORDER BY k.ord`,
    [`app.${table}`],
  );
  return rows.map((row: { column: string }) => row.column);
}

describe("mechanism (mechid) dimension", { concurrency: false }, () => {
  before(async () => {
    await control.connect();
    assert.equal(
      (await control.query("SHOW server_version_num")).rows[0]
        .server_version_num,
      "180006",
    );
    assert.equal(
      (
        await control.query(
          "SELECT count(*)::int AS n FROM pg_namespace WHERE nspname='app'",
        )
      ).rows[0].n,
      0,
      "requires disposable fixture",
    );
  });
  beforeEach(async () => {
    await control.query("DROP SCHEMA IF EXISTS app CASCADE");
    await control.query(migration("0024_neuron_documents.sql"));
    await control.query(migration("0044_mechanisms.sql"));
  });
  after(async () => {
    await control.query("DROP SCHEMA IF EXISTS app CASCADE");
    await control.end();
  });

  it("backfills legacy-shaped member rows as mechanism 0 and keys on (netuid, mechid, uid)", async () => {
    // The pre-mechanism column list must keep working: every current writer
    // uses it, and DEFAULT 0 is what makes the backfill truthful.
    await control.query(
      "INSERT INTO app.neurons_members(netuid, uid, hotkey, coldkey, shard) VALUES (7, 3, 'hot', 'cold', 0)",
    );
    assert.equal(
      (
        await control.query(
          "SELECT mechid::int AS mechid FROM app.neurons_members WHERE netuid=7 AND uid=3",
        )
      ).rows[0].mechid,
      0,
    );
    // The same (netuid, uid) under another mechanism is a DIFFERENT row now --
    // the whole point of the rekey ("every neuron row is (netuid, mechid,
    // uid)-keyed") -- while a duplicate within one mechanism stays refused.
    await control.query(
      "INSERT INTO app.neurons_members(netuid, mechid, uid, hotkey, coldkey, shard) VALUES (7, 1, 3, 'hot-m1', 'cold', 0)",
    );
    await assert.rejects(
      control.query(
        "INSERT INTO app.neurons_members(netuid, uid, hotkey, coldkey, shard) VALUES (7, 3, 'dup', 'cold', 0)",
      ),
      /unique|duplicate key/,
    );
    await assert.rejects(
      control.query(
        "INSERT INTO app.neurons_members(netuid, mechid, uid, hotkey, coldkey, shard) VALUES (7, -1, 4, 'neg', 'cold', 0)",
      ),
      /check constraint/,
    );
  });

  it("keys neuron_daily_members on (netuid, mechid, uid, snapshot_date)", async () => {
    await control.query(
      "INSERT INTO app.neuron_daily_members(netuid, uid, snapshot_date, hotkey, coldkey, shard) VALUES (7, 3, '2026-11-01', 'hot', 'cold', 0)",
    );
    await control.query(
      "INSERT INTO app.neuron_daily_members(netuid, mechid, uid, snapshot_date, hotkey, coldkey, shard) VALUES (7, 1, 3, '2026-11-01', 'hot-m1', 'cold', 0)",
    );
    await assert.rejects(
      control.query(
        "INSERT INTO app.neuron_daily_members(netuid, mechid, uid, snapshot_date, hotkey, coldkey, shard) VALUES (7, 0, 3, '2026-11-01', 'dup', 'cold', 0)",
      ),
      /unique|duplicate key/,
    );
    assert.deepEqual(await primaryKeyColumns("neuron_daily_members"), [
      "netuid",
      "mechid",
      "uid",
      "snapshot_date",
    ]);
  });

  it("rekeys neurons_documents on (netuid, mechid, day, shard) without touching its receipts", async () => {
    // Catalog-level: writes to this table require a staged decoder receipt
    // (0024's source guard), which is the engine's business, not this
    // migration's. What 0044 owns is the KEY.
    assert.deepEqual(await primaryKeyColumns("neurons_documents"), [
      "netuid",
      "mechid",
      "day",
      "shard",
    ]);
    assert.deepEqual(await primaryKeyColumns("neurons_members"), [
      "netuid",
      "mechid",
      "uid",
    ]);
  });

  it("subnet_mechanisms holds one bounded row per (netuid, mechid)", async () => {
    await control.query(
      "INSERT INTO app.subnet_mechanisms(netuid, mechid, emission_split, consensus_mode, captured_at) VALUES (7, 0, 0.75, 'Yuma3', 1763000000000)",
    );
    // A mechanism the chain has not priced yet is a NULL split, not a zero.
    await control.query(
      "INSERT INTO app.subnet_mechanisms(netuid, mechid, captured_at) VALUES (7, 1, 1763000000000)",
    );
    await assert.rejects(
      control.query(
        "INSERT INTO app.subnet_mechanisms(netuid, mechid, captured_at) VALUES (7, 0, 1763000000001)",
      ),
      /unique|duplicate key/,
    );
    await assert.rejects(
      control.query(
        "INSERT INTO app.subnet_mechanisms(netuid, mechid, emission_split, captured_at) VALUES (8, 0, 1.5, 1763000000000)",
      ),
      /check constraint/,
    );
    await assert.rejects(
      control.query(
        // Epoch-seconds where the schema demands epoch-ms: the same >= 1e12
        // floor the neuron document stamps enforce.
        "INSERT INTO app.subnet_mechanisms(netuid, mechid, captured_at) VALUES (8, 0, 1763000000)",
      ),
      /check constraint/,
    );
    await assert.rejects(
      control.query(
        "INSERT INTO app.subnet_mechanisms(netuid, mechid, captured_at) VALUES (8, -1, 1763000000000)",
      ),
      /check constraint/,
    );
  });
});
