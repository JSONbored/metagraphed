// The basket-claim event read (#13163) against the real PostgreSQL schema:
// migration 0016's app.chain_detail_account_events read through
// loadAccountBasketClaimEventsHotTier over the same scoped NATIVE_READ_STORE
// shape the native process binds, proving the column spellings, the kind
// filter and the newest-first ordering the unit tests fake.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { Client, Pool } from "pg";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";
import { createPgStoreRuntime } from "../src/pg-store-runtime.ts";
import { scopedSource } from "../src/native-api-process.ts";
import {
  accountEventsHotFloorMs,
  CHAIN_DETAIL_HOT_TIER_TABLES,
  loadAccountBasketClaimEventsHotTier,
} from "../src/chain-detail-hot-tier.ts";
import { ROOT_CLAIM_BASKET_EVENT_KINDS } from "../src/account-root-claim.ts";

const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

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

describe("pg basket-claim event read", { concurrency: false }, () => {
  const app = scopedSource(runtime, {
    name: "app",
    schema: "app",
    owner: "owner",
    relations: Object.freeze([...CHAIN_DETAIL_HOT_TIER_TABLES]),
    access: "read",
  });
  const env = {
    NATIVE_READ_STORE: {
      tables: CHAIN_DETAIL_HOT_TIER_TABLES,
      store: app.read,
    },
  };

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
    await control.query(migration("0016_chain_control.sql"));
    await control.query(
      "INSERT INTO app.chain_detail_account_events" +
        "(block_number, event_index, extrinsic_index, event_kind, hotkey, coldkey, netuid, uid, amount_tao, alpha_amount, observed_at) VALUES " +
        `(6500000, 2, 1, 'BasketClaimed', 'hk-one', '${SS58}', 0, NULL, 1.25, NULL, 1763000000000), ` +
        `(6500001, 0, NULL, 'BasketClaimDustSkipped', '${SS58}', 'ck-other', 0, NULL, NULL, NULL, 1763000000001), ` +
        // Position flow and other accounts stay out of the claims card.
        `(6500002, 1, 0, 'BasketDeposited', 'hk-one', '${SS58}', 0, NULL, 2.5, NULL, 1763000000002), ` +
        "(6500003, 1, 0, 'BasketClaimed', 'hk-two', 'ck-stranger', 0, NULL, 9.9, NULL, 1763000000003)",
    );
  });
  after(async () => {
    await control.query("DROP SCHEMA IF EXISTS app CASCADE");
    await control.end();
    await runtime.close();
  });

  it("reads only this account's claim kinds, newest first", async () => {
    const rows = await loadAccountBasketClaimEventsHotTier(
      env,
      SS58,
      ROOT_CLAIM_BASKET_EVENT_KINDS,
      100,
    );
    assert.ok(rows);
    assert.deepEqual(
      rows.map((row) => [
        row.event_kind,
        Number(row.block_number),
        Number(row.amount_tao ?? NaN) || null,
      ]),
      [
        // The hotkey-matched dust skip is newer than the coldkey-matched claim.
        ["BasketClaimDustSkipped", 6500001, null],
        ["BasketClaimed", 6500000, 1.25],
      ],
    );
  });

  it("reports the store's own coverage floor", async () => {
    assert.equal(await accountEventsHotFloorMs(env), 1763000000000);
  });
});
