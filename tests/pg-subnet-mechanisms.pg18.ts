// The PostgreSQL subnet-mechanisms store (#13162) against the real schema:
// migration 0044's app.subnet_mechanisms read through
// createPgSubnetMechanismsStore, proving the column spellings and the
// bigint-to-text crossing the unit tests fake.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { Client, Pool } from "pg";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";
import { createPgStoreRuntime } from "../src/pg-store-runtime.ts";
import { createPgSubnetMechanismsStore } from "../src/pg-subnet-mechanisms.ts";

const url = pg18FixtureUrl();
const control = new Client({
  connectionString: url.toString(),
  connectionTimeoutMillis: 2000,
  statement_timeout: 5000,
});
const runtime = createPgStoreRuntime(
  {
    connectionString: url.toString(),
    maxConnections: 1,
    connectionTimeoutMillis: 2000,
    idleTimeoutMillis: 1000,
    statementTimeoutMillis: 5000,
    onIdleError() {},
  },
  (config) => new Pool(config),
);
const migration = (name: string) =>
  readFileSync(
    new URL(`../migrations/postgres/${name}`, import.meta.url),
    "utf8",
  );

describe("pg subnet mechanisms store", { concurrency: false }, () => {
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
    await control.query(migration("0024_neuron_documents.sql"));
    await control.query(migration("0044_mechanisms.sql"));
    await control.query(
      "INSERT INTO app.subnet_mechanisms(netuid, mechid, emission_split, consensus_mode, captured_at) VALUES " +
        "(64, 1, 0.25, NULL, 1763000000001), (64, 0, 0.75, 'Yuma3', 1763000000000), (65, 0, NULL, NULL, 1763000000000)",
    );
  });
  after(async () => {
    await control.query("DROP SCHEMA IF EXISTS app CASCADE");
    await control.end();
    await runtime.close();
  });

  it("reads one subnet's registry ordered by mechid, bigints as text", async () => {
    const store = createPgSubnetMechanismsStore(runtime);
    assert.deepEqual(await store.rows(64), [
      {
        mechid: 0,
        emission_split: 0.75,
        consensus_mode: "Yuma3",
        captured_at: "1763000000000",
      },
      {
        mechid: 1,
        emission_split: 0.25,
        consensus_mode: null,
        captured_at: "1763000000001",
      },
    ]);
    assert.deepEqual(await store.rows(66), []);
    await assert.rejects(
      store.rows(-1),
      /Invalid native subnet mechanisms identity/,
    );
  });
});
