// The coldkey-swap v2 PostgreSQL schema (#13166) against the real engine:
// migration 0053's app.coldkey_swap_announcements / app.coldkey_swap_policy /
// app.key_successors read through createPgColdkeySwapsStore, proving the
// column spellings, the CHECK constraints and the bigint-to-text crossings
// the unit tests fake.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { Client, Pool } from "pg";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";
import { createPgStoreRuntime } from "../src/pg-store-runtime.ts";
import { createPgColdkeySwapsStore } from "../src/pg-coldkey-swaps.ts";

const COLDKEY = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";
const OTHER = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
const HASH = `0x${"ab".repeat(32)}`;

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

describe("pg coldkey swap v2 schema and store", { concurrency: false }, () => {
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
    await control.query(migration("0053_coldkey_swaps.sql"));
    await control.query(
      "INSERT INTO app.coldkey_swap_announcements(coldkey, new_coldkey, announcement_hash, announced_at, execute_at, disputed, disputed_at, policy_snapshot, status, captured_at) VALUES " +
        `('${COLDKEY}', '${OTHER}', '${HASH}', 5000000, 5036000, false, 5001000, true, 'announced', 1763000000001), ` +
        `('${OTHER}', NULL, NULL, NULL, 5035000, NULL, NULL, NULL, NULL, 1763000000000), ` +
        "('5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1763000000000)",
    );
    await control.query(
      "INSERT INTO app.coldkey_swap_policy(captured_at, announcement_delay, reannouncement_delay) VALUES " +
        "(1763000000000, 36000, 7200), (1762000000000, 30000, NULL)",
    );
    await control.query(
      "INSERT INTO app.key_successors(key, kind, netuid, successor, root, captured_at) VALUES " +
        `('${COLDKEY}', 'coldkey', NULL, '${OTHER}', NULL, 1763000000000), ` +
        `('${COLDKEY}', 'hotkey', 7, NULL, '${OTHER}', 1763000000001), ` +
        `('${COLDKEY}', 'hotkey', 3, '${OTHER}', '${OTHER}', 1763000000000), ` +
        `('${OTHER}', 'coldkey', NULL, NULL, '${COLDKEY}', 1763000000000)`,
    );
  });
  after(async () => {
    await control.query("DROP SCHEMA IF EXISTS app CASCADE");
    await control.end();
    await runtime.close();
  });

  it("lists pending announcements soonest-executable first, bigints as text", async () => {
    const store = createPgColdkeySwapsStore(runtime);
    const rows = await store.pending();
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[0], {
      coldkey: OTHER,
      new_coldkey: null,
      announcement_hash: null,
      announced_at: null,
      execute_at: "5035000",
      disputed: null,
      disputed_at: null,
      policy_snapshot: null,
      status: null,
      captured_at: "1763000000000",
    });
    assert.deepEqual(rows[1], {
      coldkey: COLDKEY,
      new_coldkey: OTHER,
      announcement_hash: HASH,
      announced_at: "5000000",
      execute_at: "5036000",
      disputed: false,
      disputed_at: "5001000",
      policy_snapshot: true,
      status: "announced",
      captured_at: "1763000000001",
    });
    // The announcement without a carried execute block sorts last, not out.
    assert.equal(rows[2].execute_at, null);
  });

  it("reads one account's announcement and refuses a bad identity", async () => {
    const store = createPgColdkeySwapsStore(runtime);
    const rows = await store.announcement(COLDKEY);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].coldkey, COLDKEY);
    await assert.rejects(
      store.announcement("not-an-address"),
      /Invalid native coldkey swap identity/,
    );
  });

  it("reads the newest policy capture only", async () => {
    const store = createPgColdkeySwapsStore(runtime);
    assert.deepEqual(await store.policy(), [
      {
        announcement_delay: "36000",
        reannouncement_delay: "7200",
        captured_at: "1763000000000",
      },
    ]);
  });

  it("reads one key's lineage across both planes and refuses a bad identity", async () => {
    const store = createPgColdkeySwapsStore(runtime);
    assert.deepEqual(await store.lineage(COLDKEY), [
      {
        kind: "coldkey",
        netuid: null,
        successor: OTHER,
        root: null,
        captured_at: "1763000000000",
      },
      {
        kind: "hotkey",
        netuid: 3,
        successor: OTHER,
        root: OTHER,
        captured_at: "1763000000000",
      },
      {
        kind: "hotkey",
        netuid: 7,
        successor: null,
        root: OTHER,
        captured_at: "1763000000001",
      },
    ]);
    await assert.rejects(
      store.lineage(""),
      /Invalid native key lineage identity/,
    );
  });

  it("refuses announcement rows no chain state can produce", async () => {
    for (const insert of [
      // empty announcing account
      "('', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1763000000000)",
      // malformed commitment hash
      "('5Bad', NULL, '0xZZ', NULL, NULL, NULL, NULL, NULL, NULL, 1763000000000)",
      // negative execute block
      "('5Bad', NULL, NULL, NULL, -1, NULL, NULL, NULL, NULL, 1763000000000)",
      // empty status
      "('5Bad', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '', 1763000000000)",
      // pre-epoch-ms capture stamp
      "('5Bad', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 999999999999)",
    ]) {
      await assert.rejects(
        control.query(
          "INSERT INTO app.coldkey_swap_announcements(coldkey, new_coldkey, announcement_hash, announced_at, execute_at, disputed, disputed_at, policy_snapshot, status, captured_at) VALUES " +
            insert,
        ),
        /check constraint/,
      );
    }
  });

  it("refuses lineage rows that cross the key planes or name nothing", async () => {
    for (const [insert, pattern] of [
      // a coldkey row cannot carry a netuid
      ["('5Bad', 'coldkey', 7, '5X', NULL, 1763000000000)", /check constraint/],
      // a hotkey row must carry one
      [
        "('5Bad', 'hotkey', NULL, '5X', NULL, 1763000000000)",
        /check constraint/,
      ],
      // neither successor nor root names a lineage
      [
        "('5Bad', 'coldkey', NULL, NULL, NULL, 1763000000000)",
        /check constraint/,
      ],
      // an unknown plane
      [
        "('5Bad', 'proxy', NULL, '5X', NULL, 1763000000000)",
        /check constraint/,
      ],
      // the UNIQUE NULLS NOT DISTINCT identity: a second global coldkey row
      [
        `('${COLDKEY}', 'coldkey', NULL, '5X', NULL, 1763000000002)`,
        /duplicate key/,
      ],
    ] as const) {
      await assert.rejects(
        control.query(
          "INSERT INTO app.key_successors(key, kind, netuid, successor, root, captured_at) VALUES " +
            insert,
        ),
        pattern,
      );
    }
  });
});
