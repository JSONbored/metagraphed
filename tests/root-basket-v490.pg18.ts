// Migration 0046's capture-era constraint and the basket serving SQL (#13163)
// against the real schema: a v490 capture written through the real PostgreSQL
// store (zod contract + DDL + completion triggers all live), then read back
// through the loadValidatorBaskets / loadValidatorBasket serving path the
// REST, GraphQL and MCP surfaces share.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { Client, Pool } from "pg";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";
import { createPgStoreRuntime } from "../src/pg-store-runtime.ts";
import { createPgRootBasketStore } from "../src/root-basket-pg.ts";
import {
  buildValidatorBasket,
  buildValidatorBaskets,
  loadValidatorBasket,
  loadValidatorBaskets,
} from "../src/validator-baskets.ts";
import { encodeAccountId32 } from "../src/ss58.ts";
import { syntheticBasketCapture } from "./fixtures/root-basket-capture.ts";

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

const FUND_HEX = `0x${"11".repeat(32)}`;
const FUND_SS58 = encodeAccountId32(
  Uint8Array.from({ length: 32 }, () => 0x11),
)!;

function finneyCapture(
  overrides: Partial<ReturnType<typeof syntheticBasketCapture>> = {},
) {
  return {
    ...syntheticBasketCapture(),
    network: "finney" as const,
    ...overrides,
  };
}

describe("pg root basket v490 era", { concurrency: false }, () => {
  const store = createPgRootBasketStore(runtime);
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
    await control.query(migration("0020_root_basket.sql"));
    await control.query("BEGIN");
    await control.query(migration("0021_root_basket_activate.sql"));
    await control.query("COMMIT");
    await control.query(migration("0046_root_basket_v490.sql"));
  });
  after(async () => {
    await control.query("DROP SCHEMA IF EXISTS app CASCADE");
    await control.end();
    await runtime.close();
  });

  it("accepts the audited v454 era and the v490 era through the live store", async () => {
    const legacy = await store.write(finneyCapture(), 1_763_000_000_000);
    assert.equal(legacy.replayed, false);
    const v490 = await store.write(
      finneyCapture({
        capture_id: "00000000-0000-4000-8000-000000000002",
        finalized_block_hash: `0x${"05".repeat(32)}`,
        finalized_block: "600",
        runtime_spec_version: 490,
        decoder_version: "subtensor-v490-0abc1234-v1",
      }),
      1_763_000_000_001,
    );
    assert.equal(v490.replayed, false);
  });

  it("refuses a row wearing the other era's decoder at the DDL itself", async () => {
    for (const row of [
      // v490 spec with the audited v454 decoder.
      `('0x${"aa".repeat(32)}','00000000-0000-4000-8000-00000000000a','finney','0x${"01".repeat(32)}','0x${"0a".repeat(32)}','700',490,3,'subtensor-v454-14cde641-v1','0x${"03".repeat(32)}','0','1',1,0,'not_published',NULL,'18446744073709551616','18446744073709551616')`,
      // v454 spec with a v490 decoder name.
      `('0x${"bb".repeat(32)}','00000000-0000-4000-8000-00000000000b','finney','0x${"01".repeat(32)}','0x${"0b".repeat(32)}','700',454,3,'subtensor-v490-0abc1234-v1','0x${"03".repeat(32)}','0','1',1,0,'not_published',NULL,'18446744073709551616','18446744073709551616')`,
      // A spec outside both audited eras.
      `('0x${"cc".repeat(32)}','00000000-0000-4000-8000-00000000000c','finney','0x${"01".repeat(32)}','0x${"0c".repeat(32)}','700',489,3,'subtensor-v490-0abc1234-v1','0x${"03".repeat(32)}','0','1',1,0,'not_published',NULL,'18446744073709551616','18446744073709551616')`,
    ]) {
      await assert.rejects(
        control.query(
          "INSERT INTO app.root_basket_captures (content_sha256,capture_id,network,network_genesis_hash,finalized_block_hash,finalized_block,runtime_spec_version,runtime_api_version,decoder_version,metadata_sha256,started_at_ms,finished_at_ms,expected_pages,expected_funds,index_status,index_completed_block,bag_index_q64_bits,stake_index_q64_bits) VALUES " +
            row,
        ),
        /root_basket_captures_era_check/,
      );
    }
  });

  it("serves the newest completed capture through the shared basket loaders", async () => {
    const env = { ROOT_BASKET_STORE: store };
    const loaded = await loadValidatorBaskets(env);
    assert.ok(loaded);
    const card = buildValidatorBaskets(loaded);
    const capture = card.capture as Record<string, unknown>;
    assert.equal(capture.finalized_block, "600");
    assert.equal(capture.runtime_spec_version, 490);
    assert.equal(capture.decoder_version, "subtensor-v490-0abc1234-v1");
    assert.equal(capture.accepted_at, "2025-11-13T02:13:20.001Z");
    assert.equal(card.fund_count, 1);
    const [basket] = card.baskets as Record<string, unknown>[];
    assert.equal(basket.hotkey, FUND_SS58);
    assert.equal(basket.account_id, FUND_HEX);
    assert.equal(basket.spot_nav_rao, "6000000000");
    assert.equal(basket.provisional, false);
    assert.equal(basket.first_block, "90");
    assert.equal(basket.holdings_count, 3);
    assert.equal(basket.targets_count, 2);
  });

  it("serves one validator's holdings and targets ordered by netuid", async () => {
    const env = { ROOT_BASKET_STORE: store };
    const loaded = await loadValidatorBasket(env, FUND_HEX);
    assert.ok(loaded);
    const card = buildValidatorBasket(loaded, FUND_SS58);
    assert.notEqual(card.basket, null);
    assert.deepEqual(
      (card.holdings as Record<string, unknown>[]).map((row) => [
        row.netuid,
        row.quantity_unit,
        row.quantity_atomic,
      ]),
      [
        [0, "rao", "1000000000"],
        [19, "alpha_atomic", "16000000000"],
        [50, "alpha_atomic", "6000000000"],
      ],
    );
    assert.deepEqual(card.targets, [
      { netuid: 19, weight: 2 },
      { netuid: 50, weight: 1 },
    ]);
    // A hotkey the capture holds no fund for is a measured absence.
    const absent = await loadValidatorBasket(env, `0x${"22".repeat(32)}`);
    assert.ok(absent);
    assert.equal(absent.fund, null);
  });
});
