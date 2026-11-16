// The account-plane PostgreSQL schema (#13166) against the real engine:
// migration 0054's child-key detail tables read through
// createPgChildKeysStore, and migration 0055's app.proxies / app.multisigs
// read through createPgAccountProxiesStore / createPgAccountMultisigsStore,
// proving the column spellings, the CHECK constraints, the GIN membership
// probe and the bigint-to-text crossings the unit tests fake.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { Client, Pool } from "pg";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";
import { createPgStoreRuntime } from "../src/pg-store-runtime.ts";
import { createPgChildKeysStore } from "../src/pg-child-keys.ts";
import { createPgAccountProxiesStore } from "../src/pg-proxies.ts";
import { createPgAccountMultisigsStore } from "../src/pg-multisigs.ts";

const PARENT = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";
const CHILD = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
const OTHER = "5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy";

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

describe("pg account-plane schema and stores", { concurrency: false }, () => {
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
    await control.query(migration("0054_child_keys.sql"));
    await control.query(migration("0055_proxies_multisigs.sql"));
    await control.query(
      "INSERT INTO app.childkey_takes(hotkey, netuid, take, captured_at) VALUES " +
        `('${CHILD}', 7, 11796, 1763000000000), ('${CHILD}', 3, 0, 1763000000000)`,
    );
    await control.query(
      "INSERT INTO app.pending_child_keys(parent, netuid, child, proportion, cool_down_block, captured_at) VALUES " +
        `('${PARENT}', 7, '${CHILD}', '9223372036854775808', 5036000, 1763000000000), ` +
        `('${PARENT}', 7, '${OTHER}', '0', NULL, 1763000000000)`,
    );
    await control.query(
      "INSERT INTO app.childkey_thresholds(parent, pending_check, suspended, captured_at) VALUES " +
        `('${PARENT}', true, false, 1763000000000)`,
    );
    await control.query(
      "INSERT INTO app.child_keys_history(parent, netuid, child, proportion, captured_at) VALUES " +
        `('${PARENT}', 7, '${CHILD}', '18446744073709551615', 1763000000000), ` +
        `('${PARENT}', 7, '${CHILD}', '9223372036854775808', 1763000000001)`,
    );
    await control.query(
      "INSERT INTO app.proxies(delegator, delegate, proxy_type, delay, deposit, captured_at) VALUES " +
        `('${PARENT}', '${CHILD}', 'Staking', 0, '1000000000', 1763000000000), ` +
        `('${PARENT}', '${CHILD}', 'Any', 10, '1000000000', 1763000000000)`,
    );
    await control.query(
      "INSERT INTO app.multisigs(multisig, threshold, signatories, captured_at) VALUES " +
        `('${OTHER}', 2, '["${PARENT}", "${CHILD}"]'::jsonb, 1763000000000), ` +
        `('${PARENT}', NULL, NULL, 1763000000000), ` +
        `('5HGjWAeFDfFCWPsjFQdVV2Msvz2XtMktvgocEZcCj68kUMaw', 1, '["${OTHER}"]'::jsonb, 1763000000000)`,
    );
  });
  after(async () => {
    await control.query("DROP SCHEMA IF EXISTS app CASCADE");
    await control.end();
    await runtime.close();
  });

  it("reads takes, pending, threshold and both history views", async () => {
    const store = createPgChildKeysStore(runtime);
    assert.deepEqual(await store.takes(CHILD), [
      { netuid: 3, take: 0, captured_at: "1763000000000" },
      { netuid: 7, take: 11796, captured_at: "1763000000000" },
    ]);
    assert.deepEqual(await store.pending(PARENT), [
      {
        netuid: 7,
        child: OTHER,
        proportion: "0",
        cool_down_block: null,
        captured_at: "1763000000000",
      },
      {
        netuid: 7,
        child: CHILD,
        proportion: "9223372036854775808",
        cool_down_block: "5036000",
        captured_at: "1763000000000",
      },
    ]);
    assert.deepEqual(await store.threshold(PARENT), [
      { pending_check: true, suspended: false, captured_at: "1763000000000" },
    ]);
    const byParent = await store.historyByParent(PARENT);
    assert.equal(byParent.length, 2);
    assert.equal(byParent[0].captured_at, "1763000000001");
    const byChild = await store.historyByChild(CHILD);
    assert.equal(byChild.length, 2);
    assert.deepEqual(await store.historyByChild(OTHER), []);
    await assert.rejects(
      store.takes("not-an-address"),
      /Invalid native childkey take identity/,
    );
  });

  it("reads one delegator's proxies and the GIN-backed multisig membership", async () => {
    const proxies = createPgAccountProxiesStore(runtime);
    assert.deepEqual(await proxies.rows(PARENT), [
      {
        delegate: CHILD,
        proxy_type: "Any",
        delay: "10",
        deposit: "1000000000",
        captured_at: "1763000000000",
      },
      {
        delegate: CHILD,
        proxy_type: "Staking",
        delay: "0",
        deposit: "1000000000",
        captured_at: "1763000000000",
      },
    ]);
    await assert.rejects(
      proxies.rows(""),
      /Invalid native account proxies identity/,
    );

    const multisigs = createPgAccountMultisigsStore(runtime);
    // PARENT matches both ways: as a signatory of OTHER's multisig and as a
    // multisig account itself.
    const rows = await multisigs.byMember(PARENT);
    assert.deepEqual(
      rows.map((row) => row.multisig),
      [OTHER, PARENT],
    );
    assert.deepEqual(rows[0].signatories, [PARENT, CHILD]);
    assert.equal(rows[0].threshold, "2");
    assert.equal(rows[1].signatories, null);
    assert.deepEqual(
      (await multisigs.byMember(OTHER)).map((row) => row.multisig),
      [OTHER, "5HGjWAeFDfFCWPsjFQdVV2Msvz2XtMktvgocEZcCj68kUMaw"],
    );
    await assert.rejects(
      multisigs.byMember("5short"),
      /Invalid native account multisigs identity/,
    );
  });

  it("refuses rows no chain state can produce", async () => {
    for (const [sql, pattern] of [
      // a take past PerU16
      [
        "INSERT INTO app.childkey_takes(hotkey, netuid, take, captured_at) VALUES ('5Bad', 7, 65536, 1763000000000)",
        /check constraint/,
      ],
      // non-canonical proportion text
      [
        `INSERT INTO app.pending_child_keys(parent, netuid, child, proportion, captured_at) VALUES ('5Bad', 7, '5X', '01', 1763000000000)`,
        /check constraint/,
      ],
      // u64 overflow in history
      [
        "INSERT INTO app.child_keys_history(parent, netuid, child, proportion, captured_at) VALUES ('5Bad', 7, '5X', '18446744073709551616', 1763000000000)",
        /check constraint/,
      ],
      // a negative proxy delay
      [
        "INSERT INTO app.proxies(delegator, delegate, proxy_type, delay, captured_at) VALUES ('5Bad', '5X', 'Any', -1, 1763000000000)",
        /check constraint/,
      ],
      // an empty proxy variant
      [
        "INSERT INTO app.proxies(delegator, delegate, proxy_type, delay, captured_at) VALUES ('5Bad', '5X', '', 0, 1763000000000)",
        /check constraint/,
      ],
      // a zero multisig threshold
      [
        "INSERT INTO app.multisigs(multisig, threshold, captured_at) VALUES ('5Bad', 0, 1763000000000)",
        /check constraint/,
      ],
      // a non-array signatory set
      [
        `INSERT INTO app.multisigs(multisig, signatories, captured_at) VALUES ('5Bad', '{"a":1}'::jsonb, 1763000000000)`,
        /check constraint/,
      ],
    ] as const) {
      await assert.rejects(control.query(sql), pattern, sql.slice(0, 60));
    }
  });
});
