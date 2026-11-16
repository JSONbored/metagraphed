// The LimitOrders PostgreSQL schema (#13165) against the real engine:
// migration 0050's app.limit_orders / app.limit_order_events, read through
// createPgSubnetLimitOrdersStore, proving the column spellings, the CHECK
// constraints and the bigint-to-text crossings the unit tests fake.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { Client, Pool } from "pg";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";
import { createPgStoreRuntime } from "../src/pg-store-runtime.ts";
import { createPgSubnetLimitOrdersStore } from "../src/pg-subnet-limit-orders.ts";

const OWNER = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";
const ORDER_A = `0x${"ab".repeat(32)}`;
const ORDER_B = `0x${"cd".repeat(32)}`;
const ORDER_C = `0x${"ef".repeat(32)}`;

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

describe("pg limit-orders schema and store", { concurrency: false }, () => {
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
    await control.query(migration("0050_limit_orders.sql"));
    await control.query(
      "INSERT INTO app.limit_orders(order_id, owner, netuid, kind, amount, price, status, captured_at) VALUES " +
        `('${ORDER_A}', '${OWNER}', 64, 'Buy', '65802619318', '12500', 'PartiallyFilled', 1763000000000), ` +
        `('${ORDER_B}', '${OWNER}', 64, 'Sell', NULL, NULL, NULL, 1763000000001), ` +
        `('${ORDER_C}', '${OWNER}', 7, 'Buy', '0', '340282366920938463463374607431768211455', 'Cancelled', 1763000000000)`,
    );
    await control.query(
      "INSERT INTO app.limit_order_events(block_number, event_index, kind, order_id, signer, netuid, amount_in, amount_out, occurred_at) VALUES " +
        `(8605497, 410, 'OrderExecuted', '${ORDER_A}', '${OWNER}', 97, '65802619318', '12500', 1763000000000), ` +
        "(8605498, 2, 'LimitOrdersPalletStatusChanged', NULL, NULL, NULL, NULL, NULL, 1763000000000)",
    );
  });
  after(async () => {
    await control.query("DROP SCHEMA IF EXISTS app CASCADE");
    await control.end();
    await runtime.close();
  });

  it("reads one subnet's orders newest-first, bigints as text", async () => {
    const store = createPgSubnetLimitOrdersStore(runtime);
    assert.deepEqual(await store.rows(64), [
      {
        order_id: ORDER_B,
        owner: OWNER,
        kind: "Sell",
        amount: null,
        price: null,
        status: null,
        captured_at: "1763000000001",
      },
      {
        order_id: ORDER_A,
        owner: OWNER,
        kind: "Buy",
        amount: "65802619318",
        price: "12500",
        status: "PartiallyFilled",
        captured_at: "1763000000000",
      },
    ]);
    assert.deepEqual(await store.rows(66), []);
    await assert.rejects(
      store.rows(-1),
      /Invalid native subnet limit orders identity/,
    );
    await assert.rejects(
      store.rows(65536),
      /Invalid native subnet limit orders identity/,
    );
  });

  it("refuses an order with a malformed key, identity or quantity", async () => {
    for (const insert of [
      `('not-an-h256', '${OWNER}', 7, 'Buy', NULL, NULL, NULL, 1763000000000)`,
      `('0x${"AB".repeat(32)}', '${OWNER}', 7, 'Buy', NULL, NULL, NULL, 1763000000000)`,
      `('0x${"11".repeat(32)}', '', 7, 'Buy', NULL, NULL, NULL, 1763000000000)`,
      `('0x${"11".repeat(32)}', '${OWNER}', 70000, 'Buy', NULL, NULL, NULL, 1763000000000)`,
      `('0x${"11".repeat(32)}', '${OWNER}', 7, '', NULL, NULL, NULL, 1763000000000)`,
      `('0x${"11".repeat(32)}', '${OWNER}', 7, 'Buy', '01', NULL, NULL, 1763000000000)`,
      `('0x${"11".repeat(32)}', '${OWNER}', 7, 'Buy', '18446744073709551616', NULL, NULL, 1763000000000)`,
      `('0x${"11".repeat(32)}', '${OWNER}', 7, 'Buy', NULL, '1.5', NULL, 1763000000000)`,
      `('0x${"11".repeat(32)}', '${OWNER}', 7, 'Buy', NULL, NULL, '', 1763000000000)`,
      `('0x${"11".repeat(32)}', '${OWNER}', 7, 'Buy', NULL, NULL, NULL, 999999999999)`,
    ]) {
      await assert.rejects(
        control.query(
          "INSERT INTO app.limit_orders(order_id, owner, netuid, kind, amount, price, status, captured_at) VALUES " +
            insert,
        ),
        /check constraint/,
      );
    }
  });

  it("a second row for the same order is refused by the primary key", async () => {
    await assert.rejects(
      control.query(
        "INSERT INTO app.limit_orders(order_id, owner, netuid, kind, amount, price, status, captured_at) VALUES " +
          `('${ORDER_A}', '${OWNER}', 64, 'Buy', NULL, NULL, NULL, 1763000000002)`,
      ),
      /duplicate key/,
    );
  });

  it("refuses a limit-order event without a kind or with a malformed field", async () => {
    for (const insert of [
      "(1, 0, '', NULL, NULL, NULL, NULL, NULL, 1763000000000)",
      "(1, 0, 'OrderExecuted', 'not-an-h256', NULL, NULL, NULL, NULL, 1763000000000)",
      "(1, 0, 'OrderExecuted', NULL, '', NULL, NULL, NULL, 1763000000000)",
      "(1, 0, 'OrderExecuted', NULL, NULL, 70000, NULL, NULL, 1763000000000)",
      "(1, 0, 'OrderExecuted', NULL, NULL, NULL, '01', NULL, 1763000000000)",
      "(1, 0, 'OrderExecuted', NULL, NULL, NULL, NULL, '-1', 1763000000000)",
      "(-1, 0, 'OrderExecuted', NULL, NULL, NULL, NULL, NULL, 1763000000000)",
      "(1, -1, 'OrderExecuted', NULL, NULL, NULL, NULL, NULL, 1763000000000)",
      "(1, 0, 'OrderExecuted', NULL, NULL, NULL, NULL, NULL, 999999999999)",
    ]) {
      await assert.rejects(
        control.query(
          "INSERT INTO app.limit_order_events(block_number, event_index, kind, order_id, signer, netuid, amount_in, amount_out, occurred_at) VALUES " +
            insert,
        ),
        /check constraint/,
      );
    }
  });
});
