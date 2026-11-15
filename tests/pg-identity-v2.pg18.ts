// The identity-v2 labelling schema (#13166) against the real engine:
// migration 0052's storage_version columns on app.account_identity and
// app.account_identity_history, proving the column spelling and the CHECK
// constraint the unit tests fake. The writer -- the engine's labelled
// SubtensorModule.IdentitiesV2 decode -- lands with the engine, so the
// label's one invariant today is that an unlabelled row stays NULL and a
// non-positive label cannot be stored at all.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { Client } from "pg";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";

const url = pg18FixtureUrl();
const control = new Client({
  connectionString: url.toString(),
  connectionTimeoutMillis: 2000,
  statement_timeout: 5000,
});
const migration = (name: string) =>
  readFileSync(
    new URL(`../migrations/postgres/${name}`, import.meta.url),
    "utf8",
  );

describe("pg identity v2 labelling schema", { concurrency: false }, () => {
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
    await control.query(migration("0014_account_observations.sql"));
    await control.query(migration("0052_identity_v2.sql"));
  });
  after(async () => {
    await control.query("DROP SCHEMA IF EXISTS app CASCADE");
    await control.end();
  });

  it("stores a labelled row and keeps an unlabelled row truthfully NULL", async () => {
    await control.query(
      "INSERT INTO app.account_identity(account, name, captured_at, storage_version) " +
        "VALUES ('5Labelled', 'Example', 1763000000000, 2)",
    );
    // The deployed sync write path binds the pre-0052 column list -- an
    // insert that never names the label is exactly what production writes,
    // and it must land as NULL, never a fabricated 2.
    await control.query(
      "INSERT INTO app.account_identity(account, name, captured_at) " +
        "VALUES ('5Unlabelled', 'Example', 1763000000000)",
    );
    const rows = await control.query(
      "SELECT account, storage_version::int AS storage_version " +
        "FROM app.account_identity ORDER BY account",
    );
    assert.deepEqual(rows.rows, [
      { account: "5Labelled", storage_version: 2 },
      { account: "5Unlabelled", storage_version: null },
    ]);
  });

  it("labels history entries the same way", async () => {
    await control.query(
      "INSERT INTO app.account_identity_history(account, observed_at, identity_hash, storage_version) " +
        "VALUES ('5Labelled', 1763000000000, 'hash', 2)",
    );
    await control.query(
      "INSERT INTO app.account_identity_history(account, observed_at, identity_hash) " +
        "VALUES ('5Unlabelled', 1763000000000, 'hash')",
    );
    const rows = await control.query(
      "SELECT account, storage_version::int AS storage_version " +
        "FROM app.account_identity_history ORDER BY account",
    );
    assert.deepEqual(rows.rows, [
      { account: "5Labelled", storage_version: 2 },
      { account: "5Unlabelled", storage_version: null },
    ]);
  });

  it("refuses a label no storage map can have", async () => {
    for (const label of ["0", "-1"]) {
      await assert.rejects(
        control.query(
          "INSERT INTO app.account_identity(account, captured_at, storage_version) " +
            `VALUES ('5Bad', 1763000000000, ${label})`,
        ),
        /check constraint/,
        `account_identity storage_version=${label}`,
      );
      await assert.rejects(
        control.query(
          "INSERT INTO app.account_identity_history(account, observed_at, identity_hash, storage_version) " +
            `VALUES ('5Bad', 1763000000000, 'hash', ${label})`,
        ),
        /check constraint/,
        `account_identity_history storage_version=${label}`,
      );
    }
  });
});
