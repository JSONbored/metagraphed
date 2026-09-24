import assert from "node:assert/strict";
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
const env = { D1_STATE: db, D1_STATE_TABLES: "nominator_positions,neurons" };
const page = vi.spyOn(feeds, "loadIndexedAccountFeedPage"),
  floor = vi.spyOn(projection, "accountHistoryFloorMs");
beforeAll(async () => {
  await db.exec(
    "CREATE TABLE nominator_positions(coldkey TEXT,hotkey TEXT,netuid INTEGER,share_fraction REAL,captured_at); CREATE TABLE neurons(hotkey TEXT,netuid INTEGER,stake_tao REAL);",
  );
});
afterAll(() => runtime.dispose());
beforeEach(async () => {
  await db.exec("DELETE FROM nominator_positions; DELETE FROM neurons;");
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
    .prepare("INSERT INTO nominator_positions VALUES(?,?,?,?,?)")
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
  test("prices exact share fractions with current stakes and preserves alpha units and capture time", async () => {
    await position();
    await position(HOTKEY_B, 4, 0.25);
    await stake();
    await stake(HOTKEY_B, 4, 40);
    const result = await loadAccountPositionsColdTier(env, COLDKEY);
    assert.equal(result?.position_count, 2);
    assert.equal(result.total_stake_alpha, 60);
    assert.equal(result.positions[0].stake_tao, 50);
    assert.equal(result.captured_at, new Date(STAMP).toISOString());
    assert.ok(!Object.hasOwn(result, "total_stake_tao"));
    assert.equal(page.mock.calls.length, 0);
  });
  test("supports hundreds of hotkeys within D1 binding limits", async () => {
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
    assert.equal(result.total_stake_alpha, 500);
  });
  test("declines beyond the complete-position cap", async () => {
    await db
      .prepare(
        "WITH RECURSIVE n(i) AS(VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i<?) INSERT INTO nominator_positions SELECT ?,?,i,1,? FROM n",
      )
      .bind(POSITION_SCAN_CAP, COLDKEY, HOTKEY_A, STAMP)
      .run();
    assert.equal(await loadAccountPositionsColdTier(env, COLDKEY), null);
  });
  test("empty positions carry the real ledger timestamp and only newer stake activity marks a contradiction", async () => {
    await db
      .prepare("INSERT INTO nominator_positions VALUES(?,?,?,?,?)")
      .bind("different", HOTKEY_A, 1, 1, STAMP)
      .run();
    for (const [observed, degraded] of [
      [STAMP - 1000, false],
      [STAMP + 3600000, true],
    ] as const) {
      page.mockResolvedValue([nativeAccountRow({ observed_at: observed })]);
      const result = await loadAccountPositionsColdTier(env, COLDKEY);
      assert.equal(result?.position_count, 0);
      assert.equal(result.total_stake_alpha, 0);
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
  test("unusable addresses and missing selected stores decline; unregistered hotkeys cannot invent stake", async () => {
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
      0,
    );
    assert.equal(
      await loadAccountPositionsColdTier(
        { ...env, D1_STATE_TABLES: "nominator_positions" },
        COLDKEY,
      ),
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
    for (const stamp of [null, "", " ", "bad", -1]) {
      await db.exec("DELETE FROM nominator_positions");
      await position(HOTKEY_A, 1, 1, stamp);
      assert.equal(await ledgerCapturedAt(env), null);
    }
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
