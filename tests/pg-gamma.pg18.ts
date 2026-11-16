// The Gamma PostgreSQL schema (#13164) against the real engine: migration
// 0047's app.chain_gamma / app.subnet_gamma / app.gamma_deposits /
// app.gamma_events / app.subnet_services, read through
// createPgSubnetGammaStore, createPgGammaDepositsStore and
// createPgSubnetServicesStore, proving the column spellings, the CHECK
// constraints and the bigint-to-text crossings the unit tests fake.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { Client, Pool } from "pg";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";
import { createPgStoreRuntime } from "../src/pg-store-runtime.ts";
import { createPgSubnetGammaStore } from "../src/pg-subnet-gamma.ts";
import { createPgGammaDepositsStore } from "../src/pg-gamma-deposits.ts";
import { createPgSubnetServicesStore } from "../src/pg-subnet-services.ts";

const COLDKEY = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

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

describe("pg gamma schema and stores", { concurrency: false }, () => {
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
    await control.query(migration("0047_gamma.sql"));
    await control.query(
      "INSERT INTO app.chain_gamma(enabled, captured_at) VALUES " +
        "(false, 1763000000000), (true, 1763000000001)",
    );
    await control.query(
      "INSERT INTO app.subnet_gamma(netuid, enabled, price, emission, pending_emission, unconverted_emission, whitelisted, captured_at) VALUES " +
        "(64, true, '340282366920938463463374607431768211455', '12500', '900', '0', false, 1763000000000), " +
        "(64, true, '12501', NULL, NULL, NULL, true, 1763000000001), " +
        "(65, NULL, NULL, NULL, NULL, NULL, NULL, 1763000000000)",
    );
    await control.query(
      "INSERT INTO app.gamma_deposits(coldkey, hotkey, netuid, balance, spender, daily_cap, closed_at, captured_at) VALUES " +
        `('${COLDKEY}', 'hk-a', 64, '900', NULL, NULL, NULL, 1763000000001), ` +
        `('${COLDKEY}', 'hk-b', 64, '12500', 'spender-a', '300', 9000000, 1763000000000), ` +
        "('5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty', 'hk-a', 7, '900', NULL, '0', NULL, 1763000000000)",
    );
    await control.query(
      "INSERT INTO app.gamma_events(block_number, event_index, kind, netuid, coldkey, hotkey, amount, occurred_at) VALUES " +
        `(9000000, 2, 'GammaMinted', 64, '${COLDKEY}', 'hk-a', '12500', 1763000000000), ` +
        "(9000000, 5, 'SubnetGammaEmissionSet', 64, NULL, NULL, NULL, 1763000000000)",
    );
    await control.query(
      "INSERT INTO app.subnet_services(netuid, hotkey, service_url, set_at, captured_at) VALUES " +
        "(64, 'hk-b', 'https://sn64-b.example.com/v1', 9000000, 1763000000000), " +
        "(64, 'hk-a', 'https://sn64-a.example.com/v1', NULL, 1763000000001), " +
        "(65, 'hk-a', 'https://sn65.example.com/v1', NULL, 1763000000000)",
    );
  });
  after(async () => {
    await control.query("DROP SCHEMA IF EXISTS app CASCADE");
    await control.end();
    await runtime.close();
  });

  it("latest/history/chain/enabled read the capture series, bigints as text", async () => {
    const store = createPgSubnetGammaStore(runtime);
    assert.deepEqual(await store.latest(64), [
      {
        enabled: true,
        price: "12501",
        emission: null,
        pending_emission: null,
        unconverted_emission: null,
        whitelisted: true,
        captured_at: "1763000000001",
      },
    ]);
    assert.deepEqual(await store.latest(66), []);
    const history = await store.history(64);
    assert.equal(history.length, 2);
    assert.equal(history[0].captured_at, "1763000000001");
    assert.equal(history[1].price, "340282366920938463463374607431768211455");
    const chain = await store.chain();
    assert.deepEqual(
      chain.map((row) => [row.netuid, row.captured_at]),
      [
        [64, "1763000000001"],
        [65, "1763000000000"],
      ],
    );
    // The newest global flag, not the older false row.
    assert.deepEqual(await store.enabled(), [
      { enabled: true, captured_at: "1763000000001" },
    ]);
    await assert.rejects(
      store.latest(-1),
      /Invalid native subnet gamma identity/,
    );
    await assert.rejects(
      store.history(65536),
      /Invalid native subnet gamma identity/,
    );
  });

  it("refuses a gamma capture with non-canonical values or a stale stamp", async () => {
    for (const insert of [
      "(66, NULL, '01', NULL, NULL, NULL, NULL, 1763000000000)",
      "(66, NULL, NULL, '18446744073709551616', NULL, NULL, NULL, 1763000000000)",
      "(66, NULL, NULL, NULL, '-1', NULL, NULL, 1763000000000)",
      "(66, NULL, NULL, NULL, NULL, '1.5', NULL, 1763000000000)",
      "(66, NULL, NULL, NULL, NULL, NULL, NULL, 999999999999)",
      "(70000, NULL, NULL, NULL, NULL, NULL, NULL, 1763000000000)",
    ]) {
      await assert.rejects(
        control.query(
          "INSERT INTO app.subnet_gamma(netuid, enabled, price, emission, pending_emission, unconverted_emission, whitelisted, captured_at) VALUES " +
            insert,
        ),
        /check constraint/,
      );
    }
  });

  it("reads the deposits largest-first, bigints as text", async () => {
    const store = createPgGammaDepositsStore(runtime);
    assert.deepEqual(await store.rows(), [
      {
        coldkey: COLDKEY,
        hotkey: "hk-b",
        netuid: 64,
        balance: "12500",
        spender: "spender-a",
        daily_cap: "300",
        closed_at: "9000000",
        captured_at: "1763000000000",
      },
      {
        coldkey: "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty",
        hotkey: "hk-a",
        netuid: 7,
        balance: "900",
        spender: null,
        daily_cap: "0",
        closed_at: null,
        captured_at: "1763000000000",
      },
      {
        coldkey: COLDKEY,
        hotkey: "hk-a",
        netuid: 64,
        balance: "900",
        spender: null,
        daily_cap: null,
        closed_at: null,
        captured_at: "1763000000001",
      },
    ]);
  });

  it("refuses a deposit without a balance, with padding, or out of range", async () => {
    for (const insert of [
      "('ck-bad', 'hk', 7, NULL, NULL, NULL, NULL, 1763000000000)",
      "('ck-bad', 'hk', 7, '01', NULL, NULL, NULL, 1763000000000)",
      "('ck-bad', 'hk', 7, '1', '', NULL, NULL, 1763000000000)",
      "('ck-bad', 'hk', 7, '1', NULL, '18446744073709551616', NULL, 1763000000000)",
      "('ck-bad', 'hk', 7, '1', NULL, NULL, -1, 1763000000000)",
      "('', 'hk', 7, '1', NULL, NULL, NULL, 1763000000000)",
      "('ck-bad', 'hk', 70000, '1', NULL, NULL, NULL, 1763000000000)",
    ]) {
      await assert.rejects(
        control.query(
          "INSERT INTO app.gamma_deposits(coldkey, hotkey, netuid, balance, spender, daily_cap, closed_at, captured_at) VALUES " +
            insert,
        ),
        /check constraint|not-null constraint/,
      );
    }
  });

  it("refuses a gamma event without a kind or with a non-canonical amount", async () => {
    for (const insert of [
      "(1, 0, '', NULL, NULL, NULL, NULL, 1763000000000)",
      "(1, 0, 'GammaMinted', 70000, NULL, NULL, NULL, 1763000000000)",
      "(1, 0, 'GammaMinted', NULL, '', NULL, NULL, 1763000000000)",
      "(1, 0, 'GammaMinted', NULL, NULL, NULL, '01', 1763000000000)",
      "(-1, 0, 'GammaMinted', NULL, NULL, NULL, NULL, 1763000000000)",
      "(1, -1, 'GammaMinted', NULL, NULL, NULL, NULL, 1763000000000)",
    ]) {
      await assert.rejects(
        control.query(
          "INSERT INTO app.gamma_events(block_number, event_index, kind, netuid, coldkey, hotkey, amount, occurred_at) VALUES " +
            insert,
        ),
        /check constraint/,
      );
    }
  });

  it("reads one subnet's services ordered by hotkey, bigints as text", async () => {
    const store = createPgSubnetServicesStore(runtime);
    assert.deepEqual(await store.rows(64), [
      {
        hotkey: "hk-a",
        service_url: "https://sn64-a.example.com/v1",
        set_at: null,
        captured_at: "1763000000001",
      },
      {
        hotkey: "hk-b",
        service_url: "https://sn64-b.example.com/v1",
        set_at: "9000000",
        captured_at: "1763000000000",
      },
    ]);
    assert.deepEqual(await store.rows(66), []);
    await assert.rejects(
      store.rows(-1),
      /Invalid native subnet services identity/,
    );
  });

  it("refuses a service row without a URL or with a bad set_at", async () => {
    for (const insert of [
      "(7, 'hk', '', NULL, 1763000000000)",
      "(7, 'hk', NULL, NULL, 1763000000000)",
      "(7, '', 'https://x.example.com', NULL, 1763000000000)",
      "(7, 'hk', 'https://x.example.com', -1, 1763000000000)",
      "(70000, 'hk', 'https://x.example.com', NULL, 1763000000000)",
    ]) {
      await assert.rejects(
        control.query(
          "INSERT INTO app.subnet_services(netuid, hotkey, service_url, set_at, captured_at) VALUES " +
            insert,
        ),
        /check constraint|not-null constraint/,
      );
    }
  });
});
