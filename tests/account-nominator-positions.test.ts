import { describe, test } from "vitest";
import assert from "node:assert/strict";

import {
  NOMINATOR_POSITION_INSERT_COLUMNS,
  POSITIONS_DEGRADED_REASONS,
  POSITIONS_DEGRADED_SNAPSHOT_PREDATES_ACTIVITY,
  POSITIONS_DEGRADED_TIER_UNAVAILABLE,
  POSITIONS_DEGRADED_UNPRICEABLE,
  annotatePositionsSnapshot,
  buildAccountPositions,
  distinctHotkeys,
  shapeForwardedPositions,
  stakeByHotkeyNetuid,
} from "../src/account-nominator-positions.ts";
import { handleRequest } from "../workers/api.ts";
import { createLocalArtifactEnv } from "../scripts/lib.ts";

const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

describe("GET /api/v1/accounts/{ss58}/positions (#5233)", () => {
  test("cold store (no METAGRAPH_NEURONS_SOURCE flag, D1 never touched) -> 200 with an empty card", async () => {
    const res = await handleRequest(
      new Request(`https://api.metagraph.sh/api/v1/accounts/${SS58}/positions`),
      createLocalArtifactEnv() as unknown as Env,
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.ss58, SS58);
    assert.equal(body.data.position_count, 0);
    assert.equal(body.data.total_stake_alpha, null);
    assert.deepEqual(body.data.positions, []);
  });

  test("the flag being set does NOT proxy this route to DATA_API", async () => {
    // This route no longer forwards, and the whole-dispatch view is where that
    // is worth pinning: METAGRAPH_NEURONS_SOURCE is still "data-api" -- it must
    // be, for the 37 routes DATA_API really does dispatch -- and this one still
    // must not hop. DATA_API has never had a branch for
    // /accounts/:ss58/positions, so the forward could only ever reach that
    // Worker's terminal 503, at the price of two subrequests and an awaited
    // PostHog $exception before the hot leg answered anyway.
    //
    // The stub answers a PERFECTLY GOOD payload rather than failing, so the
    // assertion cannot pass by accident: if the leg came back, `position_count`
    // would be 1 and this test would say so.
    let dataApiCalls = 0;
    const res = await handleRequest(
      new Request(`https://api.metagraph.sh/api/v1/accounts/${SS58}/positions`),
      {
        ...createLocalArtifactEnv(),
        METAGRAPH_NEURONS_SOURCE: "data-api",
        DATA_API: {
          fetch: async () => {
            dataApiCalls += 1;
            return Response.json({
              schema_version: 1,
              ss58: SS58,
              captured_at: null,
              position_count: 1,
              total_stake_alpha: 250,
              positions: [
                {
                  hotkey: "5Hk1",
                  netuid: 3,
                  share_fraction: 0.25,
                  stake_tao: 250,
                },
              ],
            });
          },
        },
      } as unknown as Env,
      {},
    );
    assert.equal(res.status, 200);
    assert.equal(dataApiCalls, 0, "the DATA_API leg is gone, not merely quiet");
    const body = await res.json();
    assert.equal(body.data.ss58, SS58);
    assert.equal(body.data.position_count, 0);
    assert.deepEqual(body.data.positions, []);
  });

  test("testnet variant 404s instead of leaking a D1/R2 key (mainnet-only tier)", async () => {
    const res = await handleRequest(
      new Request(
        `https://api.metagraph.sh/api/v1/testnet/accounts/${SS58}/positions`,
      ),
      createLocalArtifactEnv() as unknown as Env,
      {},
    );
    assert.equal(res.status, 404);
  });
});

describe("stakeByHotkeyNetuid", () => {
  test("builds a hotkey|netuid -> stake_tao Map from neurons rows", () => {
    const map = stakeByHotkeyNetuid([
      { hotkey: "5Hk1", netuid: 3, stake_tao: 1000 },
      { hotkey: "5Hk1", netuid: 8, stake_tao: 500 },
    ]);
    assert.equal(map.get("5Hk1|3"), 1000);
    assert.equal(map.get("5Hk1|8"), 500);
    assert.equal(map.size, 2);
  });

  test("is cold-safe for non-array/empty input", () => {
    assert.equal(stakeByHotkeyNetuid(null).size, 0);
    assert.equal(stakeByHotkeyNetuid(undefined).size, 0);
    assert.equal(stakeByHotkeyNetuid([]).size, 0);
  });

  test("skips a row missing hotkey/netuid/stake_tao", () => {
    const map = stakeByHotkeyNetuid([
      { netuid: 3, stake_tao: 1000 },
      { hotkey: "5Hk1", stake_tao: 1000 },
      { hotkey: "5Hk1", netuid: 3 },
      { hotkey: "5Hk1", netuid: 3, stake_tao: -1 },
    ]);
    assert.equal(map.size, 0);
  });

  test("skips a row with a negative netuid or a blank/whitespace-only string netuid/stake_tao", () => {
    const map = stakeByHotkeyNetuid([
      { hotkey: "5Hk1", netuid: -1, stake_tao: 1000 },
      { hotkey: "5Hk1", netuid: "", stake_tao: 1000 },
      { hotkey: "5Hk1", netuid: "  ", stake_tao: 1000 },
      { hotkey: "5Hk1", netuid: 3, stake_tao: "" },
      { hotkey: "5Hk1", netuid: 3, stake_tao: "   " },
    ]);
    assert.equal(map.size, 0);
  });

  test("accepts a numeric-string netuid/stake_tao (D1/Postgres text cell coercion)", () => {
    const map = stakeByHotkeyNetuid([
      { hotkey: "5Hk1", netuid: "3", stake_tao: "1000" },
    ]);
    assert.equal(map.get("5Hk1|3"), 1000);
  });
});

describe("distinctHotkeys", () => {
  test("dedupes and preserves order", () => {
    const hotkeys = distinctHotkeys([
      { hotkey: "5Hk1" },
      { hotkey: "5Hk2" },
      { hotkey: "5Hk1" },
    ]);
    assert.deepEqual(hotkeys, ["5Hk1", "5Hk2"]);
  });

  test("is cold-safe and skips blank hotkeys", () => {
    assert.deepEqual(distinctHotkeys(null), []);
    assert.deepEqual(distinctHotkeys([{ hotkey: "" }, { hotkey: null }]), []);
  });
});

describe("legacy relationships preserve unknown native quantities", () => {
  const row = (hotkey: string, netuid = 1) => ({
    hotkey,
    netuid,
    share_fraction: 0.5,
    captured_at: 1780000000000,
  });
  test("registered, unregistered and Root observations survive without a fabricated holding", () => {
    const result = buildAccountPositions(
      [row("registered"), row("unregistered", 7), row("root", 0)],
      new Map([["registered|1", 1000]]),
      "account",
    );
    assert.equal(result.position_count, 3);
    assert.equal(result.total_stake_alpha, null);
    for (const position of result.positions) {
      assert.equal(position.stake_tao, null);
      assert.equal(position.alpha_rao, null);
      assert.equal(position.quantity_status, "unqualified");
    }
  });
  test("empty observed relationships and unavailable source remain distinguishable", () => {
    const quiet = buildAccountPositions([], null, "account");
    assert.equal(quiet.position_count, 0);
    assert.equal(quiet.degraded, undefined);
    const unavailable = annotatePositionsSnapshot(quiet, {
      snapshotCapturedAtMs: 1780000000000,
      latestStakeEventMs: 1785000000000,
    });
    assert.equal(
      unavailable.degraded?.reason,
      POSITIONS_DEGRADED_SNAPSHOT_PREDATES_ACTIVITY,
    );
  });
});

describe("buildAccountPositions", () => {
  const row = (overrides: Record<string, unknown> = {}) => ({
    hotkey: "h",
    netuid: 1,
    share_fraction: 0.25,
    captured_at: 1780000000000,
    ...overrides,
  });
  test("retains observation dates and ratios without multiplying unrelated voting weights", () => {
    const result = buildAccountPositions(
      [row()],
      new Map([["h|1", 1000]]),
      "account",
    );
    assert.equal(result.positions[0].share_fraction, 0.25);
    assert.equal(result.positions[0].stake_tao, null);
    assert.equal(result.total_stake_alpha, null);
    assert.equal(result.captured_at, new Date(1780000000000).toISOString());
  });
  test("orders relationships by subnet and key rather than comparing different tokens", () => {
    const result = buildAccountPositions(
      [row({ hotkey: "b", netuid: 8 }), row({ hotkey: "a", netuid: 3 })],
      new Map([["b|8", 10000]]),
      "account",
    );
    assert.deepEqual(
      result.positions.map((p) => [p.netuid, p.hotkey]),
      [
        [3, "a"],
        [8, "b"],
      ],
    );
  });
  test("keeps valid identities when ratios, maps or registration pricing are unavailable", () => {
    for (const share_fraction of [undefined, null, -1, "", "bad", Infinity]) {
      const result = buildAccountPositions(
        [row({ share_fraction })],
        null,
        "account",
      );
      assert.equal(result.position_count, 1);
      assert.equal(result.positions[0].share_fraction, null);
      assert.equal(result.positions[0].alpha_rao, null);
    }
  });
  test("rejects malformed identities while retaining numeric-string observations", () => {
    const result = buildAccountPositions(
      [
        row({ hotkey: null }),
        row({ netuid: -1 }),
        row({ netuid: 65536 }),
        row({ netuid: "3", share_fraction: "0.25" }),
      ],
      null,
      "account",
    );
    assert.equal(result.position_count, 1);
    assert.equal(result.positions[0].netuid, 3);
    assert.equal(result.positions[0].share_fraction, 0.25);
  });
  test("unknown, malformed and extreme timestamps cannot fabricate a valid date", () => {
    for (const captured_at of [undefined, null, Number.MAX_SAFE_INTEGER])
      assert.equal(
        buildAccountPositions([row({ captured_at })], null, "account")
          .captured_at,
        null,
      );
    assert.equal(
      buildAccountPositions(
        [row({ captured_at: 2000 }), row({ captured_at: 1000 })],
        null,
        "account",
      ).captured_at,
      new Date(2000).toISOString(),
    );
  });
  test("non-array inputs and extreme voting weights never acquire a financial total", () => {
    assert.deepEqual(
      buildAccountPositions(null, null, "account").positions,
      [],
    );
    const result = buildAccountPositions(
      [row()],
      new Map([["h|1", Infinity]]),
      "account",
    );
    assert.equal(result.position_count, 1);
    assert.equal(result.positions[0].stake_tao, null);
    assert.equal(result.total_stake_alpha, null);
  });
});

describe("NOMINATOR_POSITION_INSERT_COLUMNS", () => {
  test("is the exact column shape the migration/sync endpoint expect", () => {
    // `shares` joined in metagraphed-infra#414. It is the raw u128 the chain
    // holds, and it exists so `share_fraction` -- which is normalised across a
    // whole (hotkey, netuid) pool and therefore unproducible one row at a time --
    // stops being the only thing kept. That is what lets the producer stream
    // instead of buffering the entire 762,577-row keyspace.
    //
    // ORDER MATTERS, which is why this is deepEqual and not a set comparison:
    // coerceNominatorPositionSyncRow projects onto this list positionally and
    // buildPgUpsert numbers its placeholders from it, so a reordering binds
    // values to the wrong columns without failing anything.
    assert.deepEqual(NOMINATOR_POSITION_INSERT_COLUMNS, [
      "coldkey",
      "hotkey",
      "netuid",
      "share_fraction",
      "shares",
      "captured_at",
    ]);
  });
});

// #9804. The published contract and the code disagreed twice, in opposite
// directions, on the one field whose entire job is telling a caller not to
// trust the number beside it.
describe("degraded is exactly what the contract declares (#9804)", () => {
  test("every reason the code can emit is a member of the published enum", () => {
    // The enum used to be re-typed by hand in the route schema and listed two
    // of the three constants, so production served `positions_unpriceable`
    // against a contract calling it impossible: a strict client rejected a
    // valid response, and a client switching on the enum fell through silently.
    // Building the enum from this tuple is the fix; this test is what stops a
    // fourth constant being added without joining it.
    for (const reason of [
      POSITIONS_DEGRADED_TIER_UNAVAILABLE,
      POSITIONS_DEGRADED_SNAPSHOT_PREDATES_ACTIVITY,
      POSITIONS_DEGRADED_UNPRICEABLE,
    ]) {
      assert.ok(
        (POSITIONS_DEGRADED_REASONS as readonly string[]).includes(reason),
        `${reason} is emitted by this module but absent from POSITIONS_DEGRADED_REASONS, so the published enum does not declare it`,
      );
    }
  });

  test("a forwarded tier's bare degraded block is given the declared shape", () => {
    // The Postgres arm forwards an upstream payload verbatim, and production
    // serves `{"reason":"tier_unavailable"}` from it -- while the schema
    // declares snapshot_captured_at and latest_stake_event_at required
    // (nullable, but required). Null is the honest value for a stamp the
    // upstream did not send; a missing key is not.
    const shaped = shapeForwardedPositions({
      ss58: SS58,
      position_count: 0,
      degraded: { reason: POSITIONS_DEGRADED_TIER_UNAVAILABLE },
    }) as unknown as Record<string, Record<string, unknown>>;
    assert.deepEqual(shaped.degraded, {
      snapshot_captured_at: null,
      latest_stake_event_at: null,
      reason: POSITIONS_DEGRADED_TIER_UNAVAILABLE,
    });
  });

  test("it fills gaps without overwriting what the upstream did send", () => {
    const shaped = shapeForwardedPositions({
      degraded: {
        reason: POSITIONS_DEGRADED_SNAPSHOT_PREDATES_ACTIVITY,
        snapshot_captured_at: "2026-08-01T00:00:00.000Z",
      },
    }) as Record<string, Record<string, unknown>>;
    assert.equal(
      shaped.degraded.snapshot_captured_at,
      "2026-08-01T00:00:00.000Z",
    );
    assert.equal(shaped.degraded.latest_stake_event_at, null);
  });

  test("a payload with no degraded block is returned untouched", () => {
    // A measured answer must not grow a `degraded` key it never had -- that
    // would be the mirror-image defect, a healthy read wearing a decline.
    const measured = { ss58: SS58, position_count: 3 };
    assert.equal(shapeForwardedPositions(measured), measured);
  });
});
