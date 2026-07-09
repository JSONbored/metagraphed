import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import {
  buildAlphaVolume,
  loadSubnetAlphaVolume,
  STAKE_ADDED_KIND,
  STAKE_REMOVED_KIND,
} from "../src/alpha-volume.mjs";
function volumeRow(kind, overrides = {}) {
  return {
    event_kind: kind,
    alpha_volume: 0,
    tao_volume: 0,
    event_count: 0,
    ...overrides,
  };
}
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("buildAlphaVolume", () => {
  test("cold / empty / non-array inputs yield schema-stable zeros", () => {
    for (const rows of [[], null, undefined]) {
      const data = buildAlphaVolume(rows, 7);
      assert.equal(data.schema_version, 1);
      assert.equal(data.netuid, 7);
      assert.equal(data.window, "24h");
      assert.equal(data.buy_volume_alpha, 0);
      assert.equal(data.sell_volume_alpha, 0);
      assert.equal(data.total_volume_alpha, 0);
      assert.equal(data.buy_volume_tao, 0);
      assert.equal(data.sell_volume_tao, 0);
      assert.equal(data.total_volume_tao, 0);
      assert.equal(data.buy_count, 0);
      assert.equal(data.sell_count, 0);
      assert.equal(data.net_volume_alpha, 0);
      assert.equal(data.sentiment_ratio, null);
      assert.equal(data.sentiment, "neutral");
    }
  });

  test("sums StakeAdded as buys and StakeRemoved as sells; totals are unsigned (never netted)", () => {
    const rows = [
      {
        event_kind: STAKE_ADDED_KIND,
        alpha_volume: 100.5,
        tao_volume: 20.25,
        event_count: 4,
      },
      {
        event_kind: STAKE_REMOVED_KIND,
        alpha_volume: 40.25,
        tao_volume: 8.5,
        event_count: 3,
      },
    ];
    const data = buildAlphaVolume(rows, 7);
    assert.equal(data.buy_volume_alpha, 100.5);
    assert.equal(data.sell_volume_alpha, 40.25);
    assert.equal(data.total_volume_alpha, 140.75);
    assert.equal(data.buy_volume_tao, 20.25);
    assert.equal(data.sell_volume_tao, 8.5);
    assert.equal(data.total_volume_tao, 28.75);
    assert.equal(data.buy_count, 4);
    assert.equal(data.sell_count, 3);
    // net = 100.5 - 40.25 = 60.25; gross = 140.75; ratio = 60.25/140.75 = 0.4281.
    assert.equal(data.net_volume_alpha, 60.25);
    assert.equal(data.sentiment_ratio, 0.4281);
    assert.equal(data.sentiment, "bullish");
  });

  test("only one kind present leaves the other side zero", () => {
    const buys = buildAlphaVolume(
      [
        {
          event_kind: STAKE_ADDED_KIND,
          alpha_volume: 5,
          tao_volume: 1,
          event_count: 1,
        },
      ],
      7,
    );
    assert.equal(buys.buy_volume_alpha, 5);
    assert.equal(buys.sell_volume_alpha, 0);
    assert.equal(buys.total_volume_alpha, 5);
    const sells = buildAlphaVolume(
      [
        {
          event_kind: STAKE_REMOVED_KIND,
          alpha_volume: 5,
          tao_volume: 1,
          event_count: 1,
        },
      ],
      7,
    );
    assert.equal(sells.sell_volume_alpha, 5);
    assert.equal(sells.buy_volume_alpha, 0);
    assert.equal(sells.total_volume_alpha, 5);
  });

  test("coerces numeric-string D1 cells and ignores unknown kinds", () => {
    const rows = [
      {
        event_kind: STAKE_ADDED_KIND,
        alpha_volume: "12.5",
        tao_volume: "2.5",
        event_count: "2",
      },
      {
        event_kind: "WeightsSet",
        alpha_volume: "999",
        tao_volume: "999",
        event_count: "9",
      },
    ];
    const data = buildAlphaVolume(rows, 1);
    assert.equal(data.buy_volume_alpha, 12.5);
    assert.equal(data.buy_volume_tao, 2.5);
    assert.equal(data.buy_count, 2);
    assert.equal(data.sell_volume_alpha, 0);
    assert.equal(data.sell_count, 0);
  });

  test("rounds sums to rao precision (no IEEE-754 dust)", () => {
    const rows = [
      {
        event_kind: STAKE_ADDED_KIND,
        alpha_volume: 0.1 + 0.2,
        tao_volume: 0.1 + 0.2,
        event_count: 1,
      },
    ];
    const data = buildAlphaVolume(rows, 1);
    // 0.1 + 0.2 = 0.30000000000000004 -> rounded to rao (9dp) = 0.3
    assert.equal(data.buy_volume_alpha, 0.3);
    assert.equal(data.buy_volume_tao, 0.3);
    assert.equal(data.total_volume_alpha, 0.3);
  });

  test("treats a non-finite event_count cell as zero", () => {
    const data = buildAlphaVolume(
      [
        {
          event_kind: STAKE_ADDED_KIND,
          alpha_volume: 5,
          tao_volume: 1,
          event_count: "not-a-number",
        },
      ],
      1,
    );
    assert.equal(data.buy_count, 0);
    assert.equal(data.buy_volume_alpha, 5);
  });

  test("treats null/blank/non-numeric amount cells as zero, not a dropped row", () => {
    const rows = [
      {
        event_kind: STAKE_ADDED_KIND,
        alpha_volume: null,
        tao_volume: "nope",
        event_count: 2,
      },
      {
        event_kind: STAKE_REMOVED_KIND,
        alpha_volume: "",
        tao_volume: "   ",
        event_count: 3,
      },
    ];
    const data = buildAlphaVolume(rows, 1);
    assert.equal(data.buy_volume_alpha, 0);
    assert.equal(data.buy_volume_tao, 0);
    // event_count is still credited on a malformed amount cell — see the
    // buildAlphaVolume loop comment for why this deliberately diverges from
    // stake-flow's skip-the-whole-row behavior.
    assert.equal(data.buy_count, 2);
    assert.equal(data.sell_count, 3);
  });
});

describe("buy/sell sentiment indicator (#4339/8.2)", () => {
  test("pure buy volume (no sell) reads bullish with ratio 1", () => {
    const data = buildAlphaVolume(
      [volumeRow(STAKE_ADDED_KIND, { alpha_volume: 10 })],
      1,
    );
    assert.equal(data.net_volume_alpha, 10);
    assert.equal(data.sentiment_ratio, 1);
    assert.equal(data.sentiment, "bullish");
  });

  test("pure sell volume (no buy) reads bearish with ratio -1", () => {
    const data = buildAlphaVolume(
      [volumeRow(STAKE_REMOVED_KIND, { alpha_volume: 10 })],
      1,
    );
    assert.equal(data.net_volume_alpha, -10);
    assert.equal(data.sentiment_ratio, -1);
    assert.equal(data.sentiment, "bearish");
  });

  test("balanced two-way volume reads neutral with ratio 0", () => {
    const data = buildAlphaVolume(
      [
        volumeRow(STAKE_ADDED_KIND, { alpha_volume: 10 }),
        volumeRow(STAKE_REMOVED_KIND, { alpha_volume: 10 }),
      ],
      1,
    );
    assert.equal(data.net_volume_alpha, 0);
    assert.equal(data.sentiment_ratio, 0);
    assert.equal(data.sentiment, "neutral");
  });

  test("ratio exactly at the neutral band boundary (0.2) reads bullish (inclusive)", () => {
    // net = 2, gross = 10 -> ratio = 0.2 exactly.
    const data = buildAlphaVolume(
      [
        volumeRow(STAKE_ADDED_KIND, { alpha_volume: 6 }),
        volumeRow(STAKE_REMOVED_KIND, { alpha_volume: 4 }),
      ],
      1,
    );
    assert.equal(data.sentiment_ratio, 0.2);
    assert.equal(data.sentiment, "bullish");
  });

  test("ratio just under the neutral band reads neutral, not bullish", () => {
    // net = 18, gross = 100 -> ratio = 0.18.
    const data = buildAlphaVolume(
      [
        volumeRow(STAKE_ADDED_KIND, { alpha_volume: 59 }),
        volumeRow(STAKE_REMOVED_KIND, { alpha_volume: 41 }),
      ],
      1,
    );
    assert.equal(data.sentiment_ratio, 0.18);
    assert.equal(data.sentiment, "neutral");
  });

  test("a sub-perfect ratio that rounds to 1 is clamped to 0.9999, not overstated as pure", () => {
    // net = 199998, gross = 200000 -> raw = 0.99999, rounds to 1.0 at 4dp.
    const data = buildAlphaVolume(
      [
        volumeRow(STAKE_ADDED_KIND, { alpha_volume: 199_999 }),
        volumeRow(STAKE_REMOVED_KIND, { alpha_volume: 1 }),
      ],
      1,
    );
    assert.equal(data.sentiment_ratio, 0.9999);
    assert.equal(data.sentiment, "bullish");
  });

  test("a sub-perfect ratio that rounds to -1 is clamped to -0.9999, not overstated as pure", () => {
    // net = -199998, gross = 200000 -> raw = -0.99999, rounds to -1.0 at 4dp.
    const data = buildAlphaVolume(
      [
        volumeRow(STAKE_ADDED_KIND, { alpha_volume: 1 }),
        volumeRow(STAKE_REMOVED_KIND, { alpha_volume: 199_999 }),
      ],
      1,
    );
    assert.equal(data.sentiment_ratio, -0.9999);
    assert.equal(data.sentiment, "bearish");
  });

  test("zero volume reads neutral with a null ratio, not a divide-by-zero", () => {
    const data = buildAlphaVolume([], 1);
    assert.equal(data.net_volume_alpha, 0);
    assert.equal(data.sentiment_ratio, null);
    assert.equal(data.sentiment, "neutral");
  });
});

describe("loadSubnetAlphaVolume", () => {
  test("queries account_events for both stake kinds over a fixed 24h cutoff and shapes the result", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T00:00:00.000Z"));
    const calls = [];
    const d1 = async (sql, params) => {
      calls.push({ sql, params });
      return [
        {
          event_kind: STAKE_ADDED_KIND,
          alpha_volume: 200,
          tao_volume: 40,
          event_count: 5,
          last_observed: 1717000000000,
        },
        {
          event_kind: STAKE_REMOVED_KIND,
          alpha_volume: 50,
          tao_volume: 10,
          event_count: 2,
          last_observed: 1717900000000,
        },
      ];
    };
    const { data, generatedAt } = await loadSubnetAlphaVolume(d1, 7);
    assert.equal(calls.length, 1);
    const { sql, params } = calls[0];
    assert.match(sql, /FROM account_events/);
    assert.match(sql, /GROUP BY event_kind/);
    assert.match(sql, /MAX\(observed_at\)/);
    assert.equal(params[0], 7);
    assert.equal(params[1], STAKE_ADDED_KIND);
    assert.equal(params[2], STAKE_REMOVED_KIND);
    assert.equal(params[3], Date.now() - DAY_MS);
    assert.equal(data.netuid, 7);
    assert.equal(data.window, "24h");
    assert.equal(data.total_volume_alpha, 250);
    // generated_at = the newest event's observed_at, rendered as an ISO string.
    assert.equal(generatedAt, new Date(1717900000000).toISOString());
    vi.useRealTimers();
  });

  test("cold D1 (no rows) yields zeroed totals and a null generated_at", async () => {
    const d1 = async () => [];
    const { data, generatedAt } = await loadSubnetAlphaVolume(d1, 99);
    assert.equal(data.total_volume_alpha, 0);
    assert.equal(data.total_volume_tao, 0);
    assert.equal(generatedAt, null);
  });

  test("a non-array D1 result degrades to zeroed totals and null generated_at", async () => {
    const d1 = async () => null;
    const { data, generatedAt } = await loadSubnetAlphaVolume(d1, 7);
    assert.equal(data.total_volume_alpha, 0);
    assert.equal(generatedAt, null);
  });

  test("a row without a finite observed_at leaves generated_at null", async () => {
    const d1 = async () => [
      {
        event_kind: STAKE_ADDED_KIND,
        alpha_volume: 5,
        tao_volume: 1,
        event_count: 1,
      },
    ];
    const { data, generatedAt } = await loadSubnetAlphaVolume(d1, 7);
    assert.equal(data.buy_volume_alpha, 5);
    assert.equal(generatedAt, null);
  });

  test("generatedAt coerces string-typed last_observed cells to ISO timestamps", async () => {
    const d1 = async () => [
      {
        event_kind: STAKE_ADDED_KIND,
        alpha_volume: 10,
        tao_volume: 2,
        event_count: 1,
        last_observed: "1717000000000",
      },
      {
        event_kind: STAKE_REMOVED_KIND,
        alpha_volume: 5,
        tao_volume: 1,
        event_count: 1,
        last_observed: "1717900000000",
      },
    ];
    const { generatedAt } = await loadSubnetAlphaVolume(d1, 7);
    assert.equal(generatedAt, new Date(1717900000000).toISOString());
  });

  test("generatedAt stays null for blank or out-of-range last_observed (not epoch 1970)", async () => {
    for (const last_observed of [
      "",
      "   ",
      "not-a-date",
      "8640000000000001",
      null,
    ]) {
      const d1 = async () => [
        {
          event_kind: STAKE_ADDED_KIND,
          alpha_volume: 10,
          tao_volume: 2,
          event_count: 1,
          last_observed,
        },
      ];
      const { generatedAt } = await loadSubnetAlphaVolume(d1, 7);
      assert.equal(
        generatedAt,
        null,
        `last_observed=${JSON.stringify(last_observed)}`,
      );
    }
  });
});

const ctx = { waitUntil: (p) => p };

// Stub METAGRAPH_HEALTH_DB whose .all() returns the given rows and records the
// SQL — mirrors runtimeEnv in tests/runtime-versions.test.mjs.
function volumeEnv(rows, captured = {}) {
  return {
    ...createLocalArtifactEnv(),
    METAGRAPH_HEALTH_DB: {
      prepare(sql) {
        captured.sql = sql;
        return {
          bind(...params) {
            captured.params = params;
            return { all: () => Promise.resolve({ results: rows }) };
          },
        };
      },
    },
  };
}

describe("GET /api/v1/subnets/{netuid}/volume via the Worker", () => {
  test("returns the 24h volume scorecard for a warm D1", async () => {
    const captured = {};
    const env = volumeEnv(
      [
        {
          event_kind: STAKE_ADDED_KIND,
          alpha_volume: 100,
          tao_volume: 20,
          event_count: 3,
        },
      ],
      captured,
    );
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/subnets/7/volume"),
      env,
      ctx,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.netuid, 7);
    assert.equal(body.data.window, "24h");
    assert.equal(body.data.buy_volume_alpha, 100);
    assert.equal(body.data.net_volume_alpha, 100);
    assert.equal(body.data.sentiment, "bullish");
    assert.match(captured.sql, /FROM account_events/);
  });

  test("is schema-stable when D1 is cold (never 404)", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/subnets/7/volume"),
      volumeEnv([]),
      ctx,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.total_volume_alpha, 0);
  });

  test("an unsupported query param is a 400", async () => {
    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/subnets/7/volume?window=30d",
      ),
      volumeEnv([]),
      ctx,
    );
    assert.equal(res.status, 400);
  });

  test("testnet has no variant (mainnet-only account_events tier)", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/testnet/subnets/7/volume"),
      volumeEnv([]),
      ctx,
    );
    assert.equal(res.status, 404);
  });
});
