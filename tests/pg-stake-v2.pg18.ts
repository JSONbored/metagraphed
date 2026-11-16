// The stake-v2 PostgreSQL schema (#13163) against the real engine: migration
// 0045's nominator_positions v2 columns, app.subnet_alpha_dividends read
// through createPgSubnetAlphaDividendsStore and app.stake_locks read through
// createPgAccountLocksStore, proving the column spellings, the CHECK
// constraints and the bigint-to-text crossings the unit tests fake.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { Client, Pool } from "pg";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";
import { createPgStoreRuntime } from "../src/pg-store-runtime.ts";
import { createPgSubnetAlphaDividendsStore } from "../src/pg-subnet-alpha-dividends.ts";
import { createPgAccountLocksStore } from "../src/pg-stake-locks.ts";

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

describe("pg stake v2 schema and stores", { concurrency: false }, () => {
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
    await control.query(migration("0045_stake_v2.sql"));
    await control.query(
      "INSERT INTO app.subnet_alpha_dividends(netuid, hotkey, alpha_divs, root_alpha_divs, captured_at) VALUES " +
        "(64, 'hk-small', '900', NULL, 1763000000001), " +
        "(64, 'hk-large', '12500', '300', 1763000000000), " +
        "(64, 'hk-tie', '900', '0', 1763000000000), " +
        "(65, 'hk-other', NULL, NULL, 1763000000000)",
    );
    await control.query(
      "INSERT INTO app.stake_locks(coldkey, hotkey, netuid, kind, amount, maturity_block, captured_at) VALUES " +
        `('${COLDKEY}', 'hk-b', 7, 'Lock', '5000000000', 9000000, 1763000000000), ` +
        `('${COLDKEY}', 'hk-a', 7, 'DecayingLock', '1', NULL, 1763000000001), ` +
        `('${COLDKEY}', 'hk-a', 3, 'OwnerLock', '0', NULL, 1763000000000), ` +
        "('5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty', 'hk-a', 7, 'Lock', '2', NULL, 1763000000000)",
    );
  });
  after(async () => {
    await control.query("DROP SCHEMA IF EXISTS app CASCADE");
    await control.end();
    await runtime.close();
  });

  it("accepts v2 nominator position evidence and refuses non-canonical text", async () => {
    await control.query(
      "INSERT INTO app.nominator_positions(coldkey, hotkey, netuid, share_fraction, captured_at, alpha_rao, shares_v2, share_epoch) " +
        "VALUES ('ck', 'hk', 7, 0.5, 1763000000000, '18446744073709551615', '340282366920938463463374607431768211455', 12)",
    );
    // Legacy rows stay valid with every v2 column truthfully NULL.
    await control.query(
      "INSERT INTO app.nominator_positions(coldkey, hotkey, netuid, share_fraction, captured_at) " +
        "VALUES ('ck-legacy', 'hk', 7, 0.5, 1763000000000)",
    );
    const legacy = await control.query(
      "SELECT alpha_rao, shares_v2, share_epoch FROM app.nominator_positions WHERE coldkey='ck-legacy'",
    );
    assert.deepEqual(legacy.rows, [
      { alpha_rao: null, shares_v2: null, share_epoch: null },
    ]);
    for (const [column, value] of [
      ["alpha_rao", "'018'"],
      ["alpha_rao", "'18446744073709551616'"], // u64 max + 1
      ["shares_v2", "'-1'"],
      ["share_epoch", "-1"],
    ]) {
      await assert.rejects(
        control.query(
          `INSERT INTO app.nominator_positions(coldkey, hotkey, netuid, captured_at, ${column}) ` +
            `VALUES ('ck-bad', 'hk', 7, 1763000000000, ${value})`,
        ),
        /check constraint/,
      );
    }
  });

  it("reads one subnet's accruals largest-first, bigints as text", async () => {
    const store = createPgSubnetAlphaDividendsStore(runtime);
    assert.deepEqual(await store.rows(64), [
      {
        hotkey: "hk-large",
        alpha_divs: "12500",
        root_alpha_divs: "300",
        captured_at: "1763000000000",
      },
      {
        hotkey: "hk-small",
        alpha_divs: "900",
        root_alpha_divs: null,
        captured_at: "1763000000001",
      },
      {
        hotkey: "hk-tie",
        alpha_divs: "900",
        root_alpha_divs: "0",
        captured_at: "1763000000000",
      },
    ]);
    assert.deepEqual(await store.rows(66), []);
    await assert.rejects(
      store.rows(-1),
      /Invalid native subnet alpha dividends identity/,
    );
  });

  it("refuses a dividend row with non-canonical amounts or a stale stamp", async () => {
    for (const insert of [
      "(66, 'hk-bad', '01', NULL, 1763000000000)",
      "(66, 'hk-bad', NULL, '18446744073709551616', 1763000000000)",
      "(66, 'hk-bad', NULL, NULL, 999999999999)",
      "(66, '', NULL, NULL, 1763000000000)",
    ]) {
      await assert.rejects(
        control.query(
          "INSERT INTO app.subnet_alpha_dividends(netuid, hotkey, alpha_divs, root_alpha_divs, captured_at) VALUES " +
            insert,
        ),
        /check constraint/,
      );
    }
  });

  it("reads one coldkey's locks ordered by (netuid, hotkey, kind), bigints as text", async () => {
    const store = createPgAccountLocksStore(runtime);
    assert.deepEqual(await store.rows(COLDKEY), [
      {
        hotkey: "hk-a",
        netuid: 3,
        kind: "OwnerLock",
        amount: "0",
        maturity_block: null,
        captured_at: "1763000000000",
      },
      {
        hotkey: "hk-a",
        netuid: 7,
        kind: "DecayingLock",
        amount: "1",
        maturity_block: null,
        captured_at: "1763000000001",
      },
      {
        hotkey: "hk-b",
        netuid: 7,
        kind: "Lock",
        amount: "5000000000",
        maturity_block: "9000000",
        captured_at: "1763000000000",
      },
    ]);
    await assert.rejects(
      store.rows("not-an-address"),
      /Invalid native account locks identity/,
    );
  });

  it("refuses a lock row without an amount, kind or sane maturity", async () => {
    for (const insert of [
      "('ck-bad', 'hk', 7, 'Lock', NULL, NULL, 1763000000000)",
      "('ck-bad', 'hk', 7, 'Lock', '01', NULL, 1763000000000)",
      "('ck-bad', 'hk', 7, '', '1', NULL, 1763000000000)",
      "('ck-bad', 'hk', 7, 'Lock', '1', -1, 1763000000000)",
      "('ck-bad', 'hk', 70000, 'Lock', '1', NULL, 1763000000000)",
    ]) {
      await assert.rejects(
        control.query(
          "INSERT INTO app.stake_locks(coldkey, hotkey, netuid, kind, amount, maturity_block, captured_at) VALUES " +
            insert,
        ),
        /check constraint|not-null constraint/,
      );
    }
  });
});
