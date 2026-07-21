import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  formatAccountPosition,
  buildAccountPositionHistory,
} from "../src/account-position-history.ts";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";

const ctx = { waitUntil: (p) => p };
const SS58 = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

// An ACCOUNT_POSITION_DAILY_READ_COLUMNS-shaped row.
function positionRow(overrides = {}) {
  return {
    snapshot_date: "2026-06-20",
    captured_at: 1_780_000_000_000,
    uid: 3,
    coldkey: "5Cold",
    active: 1,
    validator_permit: 1,
    rank: 0.5,
    trust: 0.9,
    incentive: 0.6,
    dividends: 0.4,
    stake_tao: 456.7,
    emission_tao: 1.23,
    ...overrides,
  };
}

describe("formatAccountPosition", () => {
  test("formats a full row in the same shape as buildAccountPortfolio's positions[]", () => {
    const out = formatAccountPosition(positionRow());
    assert.deepEqual(out, {
      uid: 3,
      coldkey: "5Cold",
      role: "validator",
      active: true,
      stake_tao: 456.7,
      emission_tao: 1.23,
      rank: 0.5,
      trust: 0.9,
      incentive: 0.6,
      dividends: 0.4,
      // round9(emission_tao / stake_tao) = round9(1.23 / 456.7).
      yield: 0.002693234,
    });
  });

  test("returns null for a non-object row", () => {
    assert.equal(formatAccountPosition(null), null);
    assert.equal(formatAccountPosition(undefined), null);
    assert.equal(formatAccountPosition("x"), null);
  });

  test("role is miner when validator_permit does not coerce to 1", () => {
    for (const validator_permit of [0, null, undefined, 2]) {
      const out = formatAccountPosition(positionRow({ validator_permit }));
      assert.equal(out.role, "miner", JSON.stringify(validator_permit));
    }
  });

  test('a numeric-string "1" cell still counts as validator (D1 string coercion)', () => {
    const out = formatAccountPosition(positionRow({ validator_permit: "1" }));
    assert.equal(out.role, "validator");
  });

  test("active coerces D1's 0/1 flag to a boolean", () => {
    assert.equal(
      formatAccountPosition(positionRow({ active: 1 })).active,
      true,
    );
    assert.equal(
      formatAccountPosition(positionRow({ active: 0 })).active,
      false,
    );
    assert.equal(
      formatAccountPosition(positionRow({ active: null })).active,
      false,
    );
  });

  test("yield is null when stake is zero (undefined return, not divide-by-zero)", () => {
    const out = formatAccountPosition(
      positionRow({ stake_tao: 0, emission_tao: 5 }),
    );
    assert.equal(out.yield, null);
  });

  test("score fields are null on an absent/blank cell, not coerced to 0", () => {
    const out = formatAccountPosition(
      positionRow({ rank: null, trust: "", incentive: undefined }),
    );
    assert.equal(out.rank, null);
    assert.equal(out.trust, null);
    assert.equal(out.incentive, null);
  });

  test("score fields are null on a non-numeric, non-blank cell", () => {
    const out = formatAccountPosition(positionRow({ dividends: "garbage" }));
    assert.equal(out.dividends, null);
  });

  test("coldkey is null when absent", () => {
    assert.equal(
      formatAccountPosition(positionRow({ coldkey: null })).coldkey,
      null,
    );
  });

  test("uid is null when missing or negative, not coerced", () => {
    assert.equal(formatAccountPosition(positionRow({ uid: null })).uid, null);
    assert.equal(formatAccountPosition(positionRow({ uid: -1 })).uid, null);
  });

  test("uid tolerates a D1 numeric-string cell", () => {
    assert.equal(formatAccountPosition(positionRow({ uid: "3" })).uid, 3);
    assert.equal(formatAccountPosition(positionRow({ uid: "-1" })).uid, null);
  });

  test("malformed stake/emission cells degrade to 0, not NaN", () => {
    const out = formatAccountPosition(
      positionRow({ stake_tao: "garbage", emission_tao: undefined }),
    );
    assert.equal(out.stake_tao, 0);
    assert.equal(out.emission_tao, 0);
    assert.equal(out.yield, null);
  });
});

describe("buildAccountPositionHistory", () => {
  test("shapes rows into a schema_version-tagged points series", () => {
    const data = buildAccountPositionHistory([positionRow()], SS58, 7, {
      window: "30d",
    });
    assert.equal(data.schema_version, 1);
    assert.equal(data.ss58, SS58);
    assert.equal(data.netuid, 7);
    assert.equal(data.window, "30d");
    assert.equal(data.point_count, 1);
    assert.equal(data.points[0].snapshot_date, "2026-06-20");
    assert.equal(
      data.points[0].captured_at,
      new Date(1_780_000_000_000).toISOString(),
    );
    assert.equal(data.points[0].uid, 3);
    assert.equal(data.points[0].role, "validator");
    // netuid is NOT repeated per-point — it's the fixed scope of the series.
    assert.equal("netuid" in data.points[0], false);
  });

  test("point_count always matches points.length", () => {
    const data = buildAccountPositionHistory(
      [positionRow(), positionRow({ snapshot_date: "2026-06-21" })],
      SS58,
      7,
      {},
    );
    assert.equal(data.point_count, 2);
    assert.equal(data.points.length, 2);
  });

  test("drops malformed rows instead of throwing", () => {
    const data = buildAccountPositionHistory(
      [positionRow(), null, "garbage", undefined],
      SS58,
      7,
      {},
    );
    assert.equal(data.point_count, 1);
  });

  test("is schema-stable (empty points, not a throw) on null/empty rows", () => {
    for (const rows of [null, undefined, []]) {
      const data = buildAccountPositionHistory(rows, SS58, 7, {});
      assert.deepEqual(data.points, []);
      assert.equal(data.point_count, 0);
    }
  });

  test("window defaults to null when omitted", () => {
    const data = buildAccountPositionHistory([], SS58, 7, {});
    assert.equal(data.window, null);
  });

  test("captured_at is null for a missing/non-finite/non-positive value", () => {
    for (const captured_at of [null, undefined, "garbage", NaN, 0, -5]) {
      const data = buildAccountPositionHistory(
        [positionRow({ captured_at })],
        SS58,
        7,
        {},
      );
      assert.equal(
        data.points[0].captured_at,
        null,
        JSON.stringify(captured_at),
      );
    }
  });

  test("captured_at is null for a finite ms value outside the Date-representable range", () => {
    const data = buildAccountPositionHistory(
      [positionRow({ captured_at: 8.7e15 })],
      SS58,
      7,
      {},
    );
    assert.equal(data.points[0].captured_at, null);
  });
});

// D1 must never be queried by this route anymore — it's Postgres-only
// (#4839 shipped the write path + this read route; #4910's "no Postgres read
// route" premise was stale, and D1's own rollup has been permanently broken
// since #4908 dropped D1's `neurons` table). This stub throws if `prepare()`
// is ever called, so any regression back to a D1 fallback fails the test
// loudly instead of silently passing on stale/empty D1 data.
function positionHistoryEnv(overrides = {}) {
  return {
    ...createLocalArtifactEnv(),
    METAGRAPH_HEALTH_DB: {
      prepare() {
        throw new Error(
          "D1 must not be queried by the Postgres-only account-position-history route",
        );
      },
    },
    ...overrides,
  };
}

// A Postgres-tier env: METAGRAPH_NEURONS_SOURCE=postgres + a DATA_API stub
// returning the given account-position-history payload.
function postgresPositionHistoryEnv(payload) {
  return positionHistoryEnv({
    METAGRAPH_NEURONS_SOURCE: "postgres",
    DATA_API: { fetch: async () => Response.json(payload) },
  });
}

describe("GET /accounts/{ss58}/subnets/{netuid}/history via the Worker dispatch", () => {
  test("Postgres tier: returns the series the DATA_API binding provides", async () => {
    const env = postgresPositionHistoryEnv(
      buildAccountPositionHistory([positionRow()], SS58, 7, {
        window: "7d",
      }),
    );
    const res = await handleRequest(
      new Request(
        `https://api.metagraph.sh/api/v1/accounts/${SS58}/subnets/7/history?window=7d`,
      ),
      env,
      ctx,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.ss58, SS58);
    assert.equal(body.data.netuid, 7);
    assert.equal(body.data.points[0].snapshot_date, "2026-06-20");
    assert.match(res.headers.get("content-type"), /^application\/json/);
  });

  test("an unsupported ?window is a 400, never a silent coerce", async () => {
    const res = await handleRequest(
      new Request(
        `https://api.metagraph.sh/api/v1/accounts/${SS58}/subnets/7/history?window=400d`,
      ),
      positionHistoryEnv(),
      ctx,
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "invalid_query");
    assert.equal(body.meta.parameter, "window");
  });

  test("?window=all is accepted (forwarded to Postgres unchanged, no D1 cutoff logic left)", async () => {
    const env = postgresPositionHistoryEnv(
      buildAccountPositionHistory([positionRow()], SS58, 7, {
        window: "all",
      }),
    );
    const res = await handleRequest(
      new Request(
        `https://api.metagraph.sh/api/v1/accounts/${SS58}/subnets/7/history?window=all`,
      ),
      env,
      ctx,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.window, "all");
  });

  test("Postgres tier unavailable → 200 with empty points, never 404 or a D1 read", async () => {
    const res = await handleRequest(
      new Request(
        `https://api.metagraph.sh/api/v1/accounts/${SS58}/subnets/7/history`,
      ),
      positionHistoryEnv(),
      ctx,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.data.points, []);
    assert.equal(body.data.point_count, 0);
  });

  test("an unrecognized query param is rejected", async () => {
    const res = await handleRequest(
      new Request(
        `https://api.metagraph.sh/api/v1/accounts/${SS58}/subnets/7/history?bogus=1`,
      ),
      positionHistoryEnv(),
      ctx,
    );
    assert.equal(res.status, 400);
  });

  test("meta.generated_at reflects the newest point's captured_at (Postgres tier)", async () => {
    const env = postgresPositionHistoryEnv(
      buildAccountPositionHistory([positionRow()], SS58, 7, {
        window: "30d",
      }),
    );
    const res = await handleRequest(
      new Request(
        `https://api.metagraph.sh/api/v1/accounts/${SS58}/subnets/7/history`,
      ),
      env,
      ctx,
    );
    const body = await res.json();
    assert.equal(
      body.meta.generated_at,
      new Date(1_780_000_000_000).toISOString(),
    );
    assert.equal(body.meta.source, "metagraph-snapshot");
  });

  test("meta.generated_at is null when the Postgres tier is unavailable", async () => {
    const res = await handleRequest(
      new Request(
        `https://api.metagraph.sh/api/v1/accounts/${SS58}/subnets/7/history`,
      ),
      positionHistoryEnv(),
      ctx,
    );
    const body = await res.json();
    assert.equal(body.meta.generated_at, null);
  });

  test("an invalid ss58 in the path 404s (no route match)", async () => {
    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/accounts/not-a-valid-address/subnets/7/history",
      ),
      positionHistoryEnv(),
      ctx,
    );
    assert.equal(res.status, 404);
  });
});
