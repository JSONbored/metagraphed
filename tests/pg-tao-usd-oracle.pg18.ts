// The on-chain TAO/USD oracle PostgreSQL schema (#13164) against the real
// engine: migration 0048's app.tao_usd_oracle read through
// createPgTaoUsdOracleStore, proving the column spellings, the CHECK
// constraints and the bigint-to-text crossings the unit tests fake.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { Client, Pool } from "pg";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";
import { createPgStoreRuntime } from "../src/pg-store-runtime.ts";
import { createPgTaoUsdOracleStore } from "../src/pg-tao-usd-oracle.ts";

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

describe("pg tao usd oracle schema and store", { concurrency: false }, () => {
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
    await control.query(migration("0048_tao_usd_oracle.sql"));
    await control.query(
      "INSERT INTO app.tao_usd_oracle(block_number, usd_per_tao, price_raw, oracle, observed_at, captured_at) VALUES " +
        "(9000000, 210.0, '340282366920938463463374607431768211455', 'oracle-a', 1763000000000, 1763000000002), " +
        "(9000001, 212.5, NULL, NULL, 1763000000001, 1763000000002)",
    );
  });
  after(async () => {
    await control.query("DROP SCHEMA IF EXISTS app CASCADE");
    await control.end();
    await runtime.close();
  });

  it("reads the feed history newest block first, bigints as text", async () => {
    const store = createPgTaoUsdOracleStore(runtime);
    assert.deepEqual(await store.rows(), [
      {
        block_number: "9000001",
        usd_per_tao: 212.5,
        price_raw: null,
        oracle: null,
        observed_at: "1763000000001",
        captured_at: "1763000000002",
      },
      {
        block_number: "9000000",
        usd_per_tao: 210.0,
        price_raw: "340282366920938463463374607431768211455",
        oracle: "oracle-a",
        observed_at: "1763000000000",
        captured_at: "1763000000002",
      },
    ]);
  });

  it("refuses a feed with a zero price, padded raw bits or a stale stamp", async () => {
    for (const insert of [
      "(1, 0, NULL, NULL, 1763000000000, 1763000000000)",
      "(1, -1, NULL, NULL, 1763000000000, 1763000000000)",
      "(1, NULL, '01', NULL, 1763000000000, 1763000000000)",
      "(1, NULL, '340282366920938463463374607431768211456', NULL, 1763000000000, 1763000000000)",
      "(1, NULL, NULL, '', 1763000000000, 1763000000000)",
      "(1, NULL, NULL, NULL, 999999999999, 1763000000000)",
      "(1, NULL, NULL, NULL, 1763000000000, 999999999999)",
      "(-1, NULL, NULL, NULL, 1763000000000, 1763000000000)",
    ]) {
      await assert.rejects(
        control.query(
          "INSERT INTO app.tao_usd_oracle(block_number, usd_per_tao, price_raw, oracle, observed_at, captured_at) VALUES " +
            insert,
        ),
        /check constraint/,
      );
    }
  });
});
