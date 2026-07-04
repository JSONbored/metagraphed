import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildAccountPortfolioHistory,
  loadAccountPortfolioHistory,
  ACCOUNT_PORTFOLIO_HISTORY_ROW_CAP,
} from "../src/account-portfolio-history.mjs";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";

const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

// Two snapshot days: on 2026-06-02 the wallet holds a validator seat on 7 and a
// miner seat on 12; on 2026-06-01 only the miner seat on 12. Rows arrive
// newest-first (the loader's ORDER BY snapshot_date DESC).
const ROWS = [
  {
    snapshot_date: "2026-06-02",
    netuid: 7,
    uid: 3,
    stake_tao: 1000,
    emission_tao: 50,
    validator_permit: 1,
  },
  {
    snapshot_date: "2026-06-02",
    netuid: 12,
    uid: 8,
    stake_tao: 200,
    emission_tao: 30,
    validator_permit: 0,
  },
  {
    snapshot_date: "2026-06-01",
    netuid: 12,
    uid: 8,
    stake_tao: 150,
    emission_tao: 20,
    validator_permit: 0,
  },
];

describe("buildAccountPortfolioHistory", () => {
  test("rolls rows into per-day points, newest first", () => {
    const out = buildAccountPortfolioHistory(ROWS, SS58, { window: "30d" });
    assert.equal(out.schema_version, 1);
    assert.equal(out.ss58, SS58);
    assert.equal(out.window, "30d");
    assert.equal(out.point_count, 2);
    const [d2, d1] = out.points;
    assert.equal(d2.snapshot_date, "2026-06-02"); // newest first
    assert.equal(d2.subnet_count, 2); // netuids 7 and 12
    assert.equal(d2.position_count, 2);
    assert.equal(d2.validator_count, 1);
    assert.equal(d2.miner_count, 1);
    assert.equal(d2.total_stake_tao, 1200);
    assert.equal(d2.total_emission_tao, 80);
    assert.ok(Math.abs(d2.overall_yield - 80 / 1200) < 1e-6);
    assert.equal(d1.snapshot_date, "2026-06-01");
    assert.equal(d1.position_count, 1);
    assert.equal(d1.validator_count, 0);
    assert.equal(d1.total_stake_tao, 150);
  });

  test("overall_yield is null on a zero-stake day", () => {
    const out = buildAccountPortfolioHistory(
      [
        {
          snapshot_date: "2026-06-02",
          netuid: 7,
          stake_tao: 0,
          emission_tao: 0,
        },
      ],
      SS58,
    );
    assert.equal(out.points[0].overall_yield, null);
  });

  test("drops rows with a junk snapshot_date or netuid", () => {
    const out = buildAccountPortfolioHistory(
      [
        { snapshot_date: "2026-06-02", netuid: "7", stake_tao: "10" }, // numeric strings ok
        { snapshot_date: "nope", netuid: 7 }, // bad date → dropped
        { snapshot_date: 20260602, netuid: 7 }, // non-string date → dropped
        { snapshot_date: "2026-06-02", netuid: "" }, // blank netuid → not counted as subnet 0
        { snapshot_date: "2026-06-02", netuid: -1 }, // negative number netuid → not a subnet
      ],
      SS58,
    );
    assert.equal(out.point_count, 1); // only the one valid day bucket
    assert.equal(out.points[0].position_count, 3); // all three 2026-06-02 rows kept
    assert.equal(out.points[0].subnet_count, 1); // blank/negative netuids not subnets
    assert.equal(out.points[0].total_stake_tao, 10);
  });

  test("when capped, drops the (possibly partial) oldest day", () => {
    const out = buildAccountPortfolioHistory(ROWS, SS58, {
      window: "7d",
      capped: true,
    });
    assert.equal(out.point_count, 1); // 2026-06-01 dropped as partial
    assert.equal(out.points[0].snapshot_date, "2026-06-02");
  });

  test("capped with a single day keeps it (nothing to drop)", () => {
    const out = buildAccountPortfolioHistory(
      [{ snapshot_date: "2026-06-02", netuid: 7, stake_tao: 1 }],
      SS58,
      { capped: true },
    );
    assert.equal(out.point_count, 1);
  });

  test("cold/empty → schema-stable empty series", () => {
    const out = buildAccountPortfolioHistory([], SS58);
    assert.equal(out.point_count, 0);
    assert.deepEqual(out.points, []);
    assert.equal(out.window, "30d"); // default label
  });

  test("null-safe on junk rows", () => {
    const out = buildAccountPortfolioHistory("nope", SS58);
    assert.equal(out.point_count, 0);
    assert.deepEqual(out.points, []);
  });

  test("loadAccountPortfolioHistory filters by hotkey + window and shapes rows", async () => {
    let seen;
    const d1 = async (sql, params) => {
      seen = { sql, params };
      return ROWS;
    };
    const out = await loadAccountPortfolioHistory(d1, SS58, {
      windowLabel: "30d",
      windowDays: 30,
    });
    assert.match(
      seen.sql,
      /FROM neuron_daily WHERE hotkey = \? AND snapshot_date >= \? ORDER BY snapshot_date DESC LIMIT \?/,
    );
    assert.equal(seen.params[0], SS58);
    assert.match(seen.params[1], /^\d{4}-\d{2}-\d{2}$/); // derived cutoff date
    assert.equal(seen.params[2], ACCOUNT_PORTFOLIO_HISTORY_ROW_CAP);
    assert.equal(out.point_count, 2);
  });

  test("loader flags capped when the read hits the row cap", async () => {
    const many = Array.from(
      { length: ACCOUNT_PORTFOLIO_HISTORY_ROW_CAP },
      (_, i) => ({
        snapshot_date: i === 0 ? "2026-06-02" : "2026-06-01",
        netuid: 7,
        stake_tao: 1,
      }),
    );
    const d1 = async () => many;
    const out = await loadAccountPortfolioHistory(d1, SS58, {
      windowLabel: "7d",
      windowDays: 7,
    });
    // Oldest day dropped as partial → only the newest day survives.
    assert.equal(out.points.at(-1).snapshot_date, "2026-06-02");
  });
});

describe("GET /api/v1/accounts/{ss58}/portfolio-history", () => {
  function dailyEnv(rows) {
    return {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind: () => ({
              all: () =>
                Promise.resolve({
                  results: /FROM neuron_daily WHERE hotkey/.test(sql)
                    ? rows
                    : [],
                }),
            }),
          };
        },
      },
    };
  }

  test("returns the wallet portfolio timeline", async () => {
    const res = await handleRequest(
      new Request(
        `https://api.metagraph.sh/api/v1/accounts/${SS58}/portfolio-history?window=30d`,
      ),
      dailyEnv(ROWS),
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.schema_version, 1);
    assert.equal(body.data.ss58, SS58);
    assert.equal(body.data.window, "30d");
    assert.equal(body.data.point_count, 2);
    assert.equal(body.data.points[0].snapshot_date, "2026-06-02");
    assert.equal(
      body.meta.artifact_path,
      `/metagraph/accounts/${SS58}/portfolio-history.json`,
    );
  });

  test("rejects an unsupported window", async () => {
    const res = await handleRequest(
      new Request(
        `https://api.metagraph.sh/api/v1/accounts/${SS58}/portfolio-history?window=1y`,
      ),
      dailyEnv(ROWS),
      {},
    );
    assert.equal(res.status, 400);
  });

  test("cold store → 200 with an empty series", async () => {
    const res = await handleRequest(
      new Request(
        `https://api.metagraph.sh/api/v1/accounts/${SS58}/portfolio-history`,
      ),
      dailyEnv([]),
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.point_count, 0);
    assert.deepEqual(body.data.points, []);
  });
});
