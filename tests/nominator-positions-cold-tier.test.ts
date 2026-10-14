import assert from "node:assert/strict";
import { syntheticAlphaPosition } from "./helpers/alpha-quantity-fixture.ts";
import {
  installAlphaQuantityD1Schema,
  seedAlphaQuantityD1Pass,
} from "./helpers/alpha-quantity-d1-fixture.ts";
import { alphaQuantityProvenance } from "../src/alpha-quantity.ts";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, test, vi } from "vitest";
import {
  POSITION_SCAN_CAP,
  latestStakeEventAt,
  ledgerCapturedAt,
  loadAccountPositionsColdTier,
} from "../src/nominator-positions-cold-tier.ts";
import { POSITIONS_DEGRADED_SNAPSHOT_PREDATES_ACTIVITY } from "../src/account-nominator-positions.ts";
import * as feeds from "../src/indexed-account-feeds.ts";
import * as projection from "../src/account-summary-projection.ts";
import { nativeAccountRow } from "./helpers/native-account-row.ts";
const COLDKEY = "5Df7xwEPkZm4itD3PfSzHsV9extvnQpTFBiNCSgBCJtxEP9e",
  HOTKEY_A = "5FyVinYphF6JS5FZHzhMQffxtgbz1WxwUEBAxTRo9nABwb5g",
  HOTKEY_B = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";
const STAMP = 1785634702670;
const runtime = new Miniflare({
  modules: true,
  script: "export default {fetch(){return new Response('test')}}",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
});
const db = await runtime.getD1Database("DB");
const env = {
  D1_STATE: db,
  D1_STATE_TABLES:
    "nominator_positions,alpha_snapshot_passes,alpha_runtime_metadata,neurons",
};
const page = vi.spyOn(feeds, "loadIndexedAccountFeedPage"),
  floor = vi.spyOn(projection, "accountHistoryFloorMs");
beforeAll(async () => {
  await installAlphaQuantityD1Schema(db);
  await db.exec(
    "CREATE TABLE neurons(hotkey TEXT,netuid INTEGER,stake_tao REAL)",
  );
});
afterAll(() => runtime.dispose());
beforeEach(async () => {
  await db.exec(
    "DELETE FROM nominator_positions; DELETE FROM neurons; DELETE FROM alpha_snapshot_passes; DELETE FROM alpha_runtime_metadata;",
  );
  page.mockReset().mockResolvedValue([]);
  floor.mockReset().mockResolvedValue(null);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw Error("HTTP forbidden");
    }),
  );
});
async function position(
  hotkey = HOTKEY_A,
  netuid = 18,
  fraction = 0.5,
  stamp: unknown = STAMP,
) {
  await db
    .prepare(
      "INSERT INTO nominator_positions(coldkey,hotkey,netuid,share_fraction,captured_at) VALUES(?,?,?,?,?)",
    )
    .bind(COLDKEY, hotkey, netuid, fraction, stamp)
    .run();
}
async function stake(hotkey = HOTKEY_A, netuid = 18, value = 100) {
  await db
    .prepare("INSERT INTO neurons VALUES(?,?,?)")
    .bind(hotkey, netuid, value)
    .run();
}
describe("selected native account positions", () => {
  test.each([454, 478] as const)(
    "qualifies exact Alpha from runtime %s while conflicting neuron weights cannot price it",
    async (spec) => {
      const rows = [
        syntheticAlphaPosition(COLDKEY, HOTKEY_A, 18, "50000000001", STAMP),
        syntheticAlphaPosition(COLDKEY, HOTKEY_B, 4, "10000000002", STAMP),
      ];
      const capture = await seedAlphaQuantityD1Pass(db, STAMP, rows, spec);
      await stake(HOTKEY_A, 18, 999999);
      await stake(HOTKEY_B, 4, 0);
      const result = await loadAccountPositionsColdTier(env, COLDKEY);
      assert.equal(result?.schema_version, 2);
      assert.equal(result?.position_count, 2);
      assert.equal(result.total_stake_alpha, null);
      assert.deepEqual(
        result.positions.map((row) => row.alpha_rao),
        ["10000000002", "50000000001"],
      );
      for (const row of result.positions) {
        assert.equal(row.stake_tao, null);
        assert.equal(row.quantity_status, "qualified_snapshot");
        assert.deepEqual(row.provenance, alphaQuantityProvenance(capture));
      }
      assert.equal(result.captured_at, new Date(STAMP).toISOString());
      assert.ok(!Object.hasOwn(result, "total_stake_tao"));
      assert.equal(page.mock.calls.length, 0);
    },
  );
  test("legacy fractions preserve relationships without deriving quantities from neuron voting weights", async () => {
    await position();
    await position(HOTKEY_B, 4, 0.25);
    await stake();
    await stake(HOTKEY_B, 4, 40);
    const result = await loadAccountPositionsColdTier(env, COLDKEY);
    assert.equal(result?.position_count, 2);
    assert.equal(result.total_stake_alpha, null);
    assert.deepEqual(
      result.positions.map((row) => [row.netuid, row.share_fraction]),
      [
        [4, 0.25],
        [18, 0.5],
      ],
    );
    for (const row of result.positions) {
      assert.equal(row.stake_tao, null);
      assert.equal(row.alpha_rao, null);
      assert.equal(row.quantity_status, "unqualified");
      assert.equal(row.provenance, null);
    }
  });
  test("a newer incomplete selected pass cannot borrow the previous runtime-qualified quantities", async () => {
    await seedAlphaQuantityD1Pass(db, STAMP, [
      syntheticAlphaPosition(COLDKEY, HOTKEY_A, 18, "7", STAMP),
    ]);
    await seedAlphaQuantityD1Pass(db, STAMP + 1000, []);
    await db
      .prepare(
        "UPDATE alpha_snapshot_passes SET completed_at=NULL WHERE captured_at=?",
      )
      .bind(STAMP + 1000)
      .run();
    const result = await loadAccountPositionsColdTier(env, COLDKEY);
    assert.equal(result?.position_count, 1);
    assert.equal(result.positions[0].alpha_rao, null);
    assert.equal(result.positions[0].quantity_status, "unqualified");
  });
  test("retained metadata from another code identity cannot qualify the selected pass", async () => {
    await seedAlphaQuantityD1Pass(db, STAMP, [
      syntheticAlphaPosition(COLDKEY, HOTKEY_A, 18, "7", STAMP),
    ]);
    await db
      .prepare(
        "UPDATE alpha_snapshot_passes SET code_hash=? WHERE captured_at=?",
      )
      .bind("0x" + "0".repeat(64), STAMP)
      .run();
    const result = await loadAccountPositionsColdTier(env, COLDKEY);
    assert.equal(result?.position_count, 1);
    assert.equal(result.positions[0].quantity_status, "unqualified");
    assert.equal(result.positions[0].alpha_rao, null);
    assert.equal(result.positions[0].provenance, null);
  });
  test("supports hundreds of hotkeys without a neuron pricing fan-out", async () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({
      hotkey: `${HOTKEY_A.slice(0, 44)}${String(i).padStart(4, "0")}`,
      netuid: i,
    }));
    for (const row of rows) {
      await position(row.hotkey, row.netuid, 1);
      await stake(row.hotkey, row.netuid, 2);
    }
    const result = await loadAccountPositionsColdTier(env, COLDKEY);
    assert.equal(result?.position_count, 250);
    assert.equal(result.total_stake_alpha, null);
    assert.ok(
      result.positions.every(
        (row) =>
          row.alpha_rao === null && row.quantity_status === "unqualified",
      ),
    );
  });
  test("serves exactly the complete-position cap with no neuron fan-out", async () => {
    assert.equal(POSITION_SCAN_CAP, 2000);
    await db
      .prepare(
        "WITH RECURSIVE n(i) AS(VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i<?) INSERT INTO nominator_positions(coldkey,hotkey,netuid,share_fraction,captured_at) SELECT ?,?,i,1,? FROM n",
      )
      .bind(POSITION_SCAN_CAP - 1, COLDKEY, HOTKEY_A, STAMP)
      .run();
    const result = await loadAccountPositionsColdTier(env, COLDKEY);
    assert.equal(result?.position_count, POSITION_SCAN_CAP);
    assert.equal(result?.total_stake_alpha, null);
  });
  test("declines beyond the complete-position cap", async () => {
    await db
      .prepare(
        "WITH RECURSIVE n(i) AS(VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i<?) INSERT INTO nominator_positions(coldkey,hotkey,netuid,share_fraction,captured_at) SELECT ?,?,i,1,? FROM n",
      )
      .bind(POSITION_SCAN_CAP, COLDKEY, HOTKEY_A, STAMP)
      .run();
    assert.equal(await loadAccountPositionsColdTier(env, COLDKEY), null);
  });
  test("empty positions carry the real ledger timestamp and only newer stake activity marks a contradiction", async () => {
    await db
      .prepare(
        "INSERT INTO nominator_positions(coldkey,hotkey,netuid,share_fraction,captured_at) VALUES(?,?,?,?,?)",
      )
      .bind("different", HOTKEY_A, 1, 1, STAMP)
      .run();
    for (const [observed, degraded] of [
      [STAMP - 1000, false],
      [STAMP + 3600000, true],
    ] as const) {
      page.mockResolvedValue([nativeAccountRow({ observed_at: observed })]);
      const result = await loadAccountPositionsColdTier(env, COLDKEY);
      assert.equal(result?.position_count, 0);
      assert.equal(result.total_stake_alpha, null);
      assert.equal(result.captured_at, new Date(STAMP).toISOString());
      if (degraded)
        assert.equal(
          result.degraded?.reason,
          POSITIONS_DEGRADED_SNAPSHOT_PREDATES_ACTIVITY,
        );
      else assert.equal(result.degraded, undefined);
    }
    page.mockResolvedValue(null);
    assert.equal(
      (await loadAccountPositionsColdTier(env, COLDKEY))?.degraded,
      undefined,
    );
  });
  test("unusable addresses and missing selected stores decline; unregistered hotkeys retain unqualified relationships", async () => {
    assert.equal(await loadAccountPositionsColdTier(env, "bad"), null);
    assert.equal(await loadAccountPositionsColdTier({}, COLDKEY), null);
    assert.equal(
      await loadAccountPositionsColdTier(
        { D1_STATE_TABLES: "nominator_positions" },
        COLDKEY,
      ),
      null,
    );
    await position();
    assert.equal(
      (await loadAccountPositionsColdTier(env, COLDKEY))?.position_count,
      1,
    );
    assert.equal(
      (
        await loadAccountPositionsColdTier(
          { ...env, D1_STATE_TABLES: "nominator_positions" },
          COLDKEY,
        )
      )?.positions[0].alpha_rao,
      null,
    );
  });
});
describe("native snapshot timestamps", () => {
  test("reads the selected ledger's current timestamp without stale memoization", async () => {
    assert.equal(await ledgerCapturedAt(env), null);
    await position();
    assert.equal(await ledgerCapturedAt(env), STAMP);
    await position(HOTKEY_B, 4, 1, STAMP + 1000);
    assert.equal(await ledgerCapturedAt(env), STAMP + 1000);
  });
  test("blank, negative and unreadable stamps never become a false timestamp", async () => {
    for (const stamp of ["", " ", "bad", -1]) {
      await db.exec("DELETE FROM nominator_positions");
      await position(HOTKEY_A, 1, 1, stamp);
      assert.equal(await ledgerCapturedAt(env), null);
    }
    const nullStamp = { all: async () => ({ results: [{ latest: null }] }) };
    assert.equal(
      await ledgerCapturedAt({
        ...env,
        D1_STATE: { prepare: () => nullStamp, batch: async () => [] },
      }),
      null,
    );
    assert.equal(
      await ledgerCapturedAt({ D1_STATE_TABLES: "nominator_positions" }),
      null,
    );
  });
  test("latest stake activity is a bounded exact coldkey seek with the proven floor", async () => {
    floor.mockResolvedValue(STAMP - 1000);
    page.mockResolvedValue([nativeAccountRow({ observed_at: STAMP })]);
    assert.equal(await latestStakeEventAt(env, COLDKEY), STAMP);
    assert.deepEqual(page.mock.lastCall, [
      env,
      ["StakeAdded", "StakeRemoved"].map((kind) => ({
        side: "coldkey",
        account: COLDKEY,
        kind,
        observedStart: STAMP - 1000,
      })),
      1,
    ]);
    floor.mockResolvedValue(null);
    await latestStakeEventAt(env, COLDKEY);
    assert.equal(page.mock.lastCall?.[1][0].observedStart, undefined);
    page.mockClear();
    assert.equal(await latestStakeEventAt(env, "bad"), null);
    assert.equal(page.mock.calls.length, 0);
    for (const value of [null, undefined, []]) {
      page.mockResolvedValue(value);
      assert.equal(await latestStakeEventAt(env, COLDKEY), null);
    }
  });
});
