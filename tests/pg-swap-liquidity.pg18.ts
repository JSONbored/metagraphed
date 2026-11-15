// The Swap/AlphaAssets PostgreSQL schema (#13165) against the real engine:
// migration 0049's app.swap_balancer / app.alpha_assets, read through
// createPgSubnetSwapStore and createPgSubnetAlphaAssetsStore, proving the
// column spellings, the CHECK constraints and the bigint-to-text crossings
// the unit tests fake.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { Client, Pool } from "pg";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";
import { createPgStoreRuntime } from "../src/pg-store-runtime.ts";
import { createPgSubnetSwapStore } from "../src/pg-subnet-swap.ts";
import { createPgSubnetAlphaAssetsStore } from "../src/pg-subnet-alpha-assets.ts";

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

describe("pg swap-liquidity schema and stores", { concurrency: false }, () => {
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
    await control.query(migration("0049_swap_liquidity.sql"));
    await control.query(
      "INSERT INTO app.swap_balancer(netuid, tao_reservoir, alpha_reservoir, fee_rate, captured_at) VALUES " +
        "(64, '5000000000', '12500', 300, 1763000000000), " +
        "(64, '5000000001', NULL, NULL, 1763000000001), " +
        "(65, NULL, NULL, NULL, 1763000000000)",
    );
    await control.query(
      "INSERT INTO app.alpha_assets(netuid, total_issuance, burned, recycled, captured_at) VALUES " +
        "(64, '18446744073709551615', '900', '0', 1763000000000), " +
        "(64, '18446744073709551615', NULL, NULL, 1763000000001), " +
        "(65, NULL, NULL, NULL, 1763000000000)",
    );
  });
  after(async () => {
    await control.query("DROP SCHEMA IF EXISTS app CASCADE");
    await control.end();
    await runtime.close();
  });

  it("latest reads the newest balancer capture, bigints as text", async () => {
    const store = createPgSubnetSwapStore(runtime);
    assert.deepEqual(await store.latest(64), [
      {
        tao_reservoir: "5000000001",
        alpha_reservoir: null,
        fee_rate: null,
        captured_at: "1763000000001",
      },
    ]);
    assert.deepEqual(await store.latest(65), [
      {
        tao_reservoir: null,
        alpha_reservoir: null,
        fee_rate: null,
        captured_at: "1763000000000",
      },
    ]);
    assert.deepEqual(await store.latest(66), []);
    await assert.rejects(
      store.latest(-1),
      /Invalid native subnet swap identity/,
    );
    await assert.rejects(
      store.latest(65536),
      /Invalid native subnet swap identity/,
    );
  });

  it("refuses a balancer capture with non-canonical values or a stale stamp", async () => {
    for (const insert of [
      "(66, '01', NULL, NULL, 1763000000000)",
      "(66, NULL, '18446744073709551616', NULL, 1763000000000)",
      "(66, '-1', NULL, NULL, 1763000000000)",
      "(66, NULL, '1.5', NULL, 1763000000000)",
      "(66, NULL, NULL, -1, 1763000000000)",
      "(66, NULL, NULL, 65536, 1763000000000)",
      "(66, NULL, NULL, NULL, 999999999999)",
      "(70000, NULL, NULL, NULL, 1763000000000)",
    ]) {
      await assert.rejects(
        control.query(
          "INSERT INTO app.swap_balancer(netuid, tao_reservoir, alpha_reservoir, fee_rate, captured_at) VALUES " +
            insert,
        ),
        /check constraint/,
      );
    }
  });

  it("latest reads the newest alpha-asset capture, bigints as text", async () => {
    const store = createPgSubnetAlphaAssetsStore(runtime);
    assert.deepEqual(await store.latest(64), [
      {
        total_issuance: "18446744073709551615",
        burned: null,
        recycled: null,
        captured_at: "1763000000001",
      },
    ]);
    assert.deepEqual(await store.latest(66), []);
    await assert.rejects(
      store.latest(-1),
      /Invalid native subnet alpha assets identity/,
    );
    await assert.rejects(
      store.latest(65536),
      /Invalid native subnet alpha assets identity/,
    );
  });

  it("refuses an alpha-asset capture with non-canonical values or a stale stamp", async () => {
    for (const insert of [
      "(66, '01', NULL, NULL, 1763000000000)",
      "(66, NULL, '18446744073709551616', NULL, 1763000000000)",
      "(66, NULL, NULL, '-1', 1763000000000)",
      "(66, NULL, NULL, '1.5', 1763000000000)",
      "(66, NULL, NULL, NULL, 999999999999)",
      "(70000, NULL, NULL, NULL, 1763000000000)",
    ]) {
      await assert.rejects(
        control.query(
          "INSERT INTO app.alpha_assets(netuid, total_issuance, burned, recycled, captured_at) VALUES " +
            insert,
        ),
        /check constraint/,
      );
    }
  });

  it("a second capture at the same stamp is refused by the primary key", async () => {
    await assert.rejects(
      control.query(
        "INSERT INTO app.swap_balancer(netuid, tao_reservoir, alpha_reservoir, fee_rate, captured_at) VALUES " +
          "(64, NULL, NULL, NULL, 1763000000001)",
      ),
      /duplicate key/,
    );
    await assert.rejects(
      control.query(
        "INSERT INTO app.alpha_assets(netuid, total_issuance, burned, recycled, captured_at) VALUES " +
          "(64, NULL, NULL, NULL, 1763000000001)",
      ),
      /duplicate key/,
    );
  });
});
