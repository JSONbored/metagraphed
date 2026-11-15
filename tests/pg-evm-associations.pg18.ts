// The EVM-associations PostgreSQL schema (#13165) against the real engine:
// migration 0051's app.evm_associations, read through
// createPgEvmAssociationsStore, proving the column spellings, the CHECK
// constraints and the bigint-to-text crossings the unit tests fake.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { Client, Pool } from "pg";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";
import { createPgStoreRuntime } from "../src/pg-store-runtime.ts";
import { createPgEvmAssociationsStore } from "../src/pg-evm-associations.ts";

const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";
const H160_A = `0x${"ab".repeat(20)}`;
const H160_B = `0x${"cd".repeat(20)}`;

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

describe("pg evm-associations schema and store", { concurrency: false }, () => {
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
    await control.query("CREATE SCHEMA app");
    await control.query(migration("0051_evm_associations.sql"));
    await control.query(
      "INSERT INTO app.evm_associations(h160, ss58, netuid, uid, associated_at, captured_at) VALUES " +
        `('${H160_A}', '${SS58}', 64, 7, 9000000, 1763000000000), ` +
        `('${H160_A}', NULL, 64, 7, NULL, 1763000000001), ` +
        `('${H160_B}', '${SS58}', 7, 0, 8000000, 1763000000000)`,
    );
  });
  after(async () => {
    await control.query("DROP SCHEMA IF EXISTS app CASCADE");
    await control.end();
    await runtime.close();
  });

  it("reads one key's associations newest-first, bigints as text", async () => {
    const store = createPgEvmAssociationsStore(runtime);
    assert.deepEqual(await store.byH160(H160_A), [
      {
        ss58: null,
        netuid: 64,
        uid: 7,
        associated_at: null,
        captured_at: "1763000000001",
      },
      {
        ss58: SS58,
        netuid: 64,
        uid: 7,
        associated_at: "9000000",
        captured_at: "1763000000000",
      },
    ]);
    assert.deepEqual(await store.byH160(`0x${"ef".repeat(20)}`), []);
    await assert.rejects(
      store.byH160("not-an-address"),
      /Invalid native evm association identity/,
    );
  });

  it("refuses an association with a malformed key, identity or stamp", async () => {
    for (const insert of [
      `('not-an-address', NULL, 7, 0, NULL, 1763000000000)`,
      `('0x${"AB".repeat(20)}', NULL, 7, 0, NULL, 1763000000000)`,
      `('${H160_B}', '', 7, 0, NULL, 1763000000000)`,
      `('${H160_B}', NULL, 70000, 0, NULL, 1763000000000)`,
      `('${H160_B}', NULL, 7, 70000, NULL, 1763000000000)`,
      `('${H160_B}', NULL, 7, 0, -1, 1763000000000)`,
      `('${H160_B}', NULL, 7, 1, NULL, 999999999999)`,
    ]) {
      await assert.rejects(
        control.query(
          "INSERT INTO app.evm_associations(h160, ss58, netuid, uid, associated_at, captured_at) VALUES " +
            insert,
        ),
        /check constraint/,
      );
    }
  });

  it("a second capture of the same (netuid, uid) at the same stamp is refused", async () => {
    await assert.rejects(
      control.query(
        "INSERT INTO app.evm_associations(h160, ss58, netuid, uid, associated_at, captured_at) VALUES " +
          `('${H160_B}', NULL, 64, 7, NULL, 1763000000001)`,
      ),
      /duplicate key/,
    );
  });
});
