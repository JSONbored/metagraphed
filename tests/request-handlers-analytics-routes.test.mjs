// Direct unit tests for workers/request-handlers/analytics-routes.mjs (#1917).
// Exercises trajectory, uptime, leaderboards, and compare without routing
// through workers/api.mjs.

import assert from "node:assert/strict";
import { describe, test, beforeEach } from "vitest";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";
import {
  canonicalCompareCachePath,
  canonicalEconomicsTrendsCachePath,
  canonicalLeaderboardsCachePath,
  canonicalUptimeCachePath,
  composeCompareData,
  configureAnalyticsRoutes,
  handleCompare,
  handleEconomicsTrends,
  handleLeaderboards,
  handleTrajectory,
  handleUptime,
} from "../workers/request-handlers/analytics-routes.mjs";
import {
  unsupportedWindowMessage,
  HISTORY_WINDOWS,
} from "../src/neuron-history.mjs";
import { UPTIME_WINDOWS } from "../workers/config.mjs";

const NETUID = 7;
const OBSERVED_AT = "2026-06-24T12:00:00.000Z";

function req(path) {
  return new Request(`https://api.metagraph.sh${path}`);
}

function url(path) {
  return new URL(`https://api.metagraph.sh${path}`);
}

async function json(res) {
  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  const body = await res.json();
  assert.equal(body.ok, true);
  return body;
}

async function errorJson(res, status = 400) {
  assert.equal(res.status, status, `expected ${status}, got ${res.status}`);
  const body = await res.json();
  assert.equal(body.ok, false);
  return body;
}

function d1Env(rowsBySql = {}) {
  return {
    METAGRAPH_HEALTH_DB: {
      prepare(sql) {
        return {
          bind(..._params) {
            return {
              async all() {
                for (const [pattern, rows] of Object.entries(rowsBySql)) {
                  if (new RegExp(pattern).test(sql)) {
                    return { results: rows };
                  }
                }
                return { results: [] };
              },
            };
          },
        };
      },
    },
  };
}

beforeEach(() => {
  configureAnalyticsRoutes({
    readHealthMetaKv: async () => ({ last_run_at: OBSERVED_AT }),
    readEconomicsCurrentKv: async () => null,
  });
});

describe("handleTrajectory", () => {
  test("returns schema-stable empty trajectory on cold D1", async () => {
    const body = await json(
      await handleTrajectory(req("/"), {}, NETUID, url("/")),
    );
    assert.equal(body.data.netuid, NETUID);
    assert.deepEqual(body.data.points, []);
    assert.equal(body.data.deltas["7d"], null);
  });

  test("rejects unsupported query parameters", async () => {
    const res = await handleTrajectory(req("/"), {}, NETUID, url("/?bogus=1"));
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "bogus");
  });

  test("formats snapshot rows ascending by date", async () => {
    const env = d1Env({
      "FROM subnet_snapshots": [
        {
          snapshot_date: "2026-06-02",
          completeness_score: 40,
          surface_count: 2,
          endpoint_count: 1,
          validator_count: 8,
          miner_count: 64,
          total_stake_tao: 100,
          alpha_price_tao: 0.01,
          emission_share: 0.02,
        },
        {
          snapshot_date: "2026-06-01",
          completeness_score: 35,
          surface_count: 1,
          endpoint_count: 1,
          validator_count: 8,
          miner_count: 60,
          total_stake_tao: 90,
          alpha_price_tao: 0.01,
          emission_share: 0.02,
        },
      ],
    });
    const body = await json(
      await handleTrajectory(req("/"), env, NETUID, url("/")),
    );
    assert.deepEqual(
      body.data.points.map((p) => p.date),
      ["2026-06-01", "2026-06-02"],
    );
    assert.equal(body.data.points[1].completeness_score, 40);
  });
});

describe("handleEconomicsTrends", () => {
  test("returns schema-stable empty series on cold D1", async () => {
    const body = await json(
      await handleEconomicsTrends(req("/"), {}, url("/")),
    );
    assert.equal(body.data.day_count, 0);
    assert.deepEqual(body.data.days, []);
    assert.equal(body.data.window, "30d");
  });

  test("rejects unsupported query parameters", async () => {
    const res = await handleEconomicsTrends(req("/"), {}, url("/?bogus=1"));
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "bogus");
  });

  test("rejects an invalid window", async () => {
    const res = await handleEconomicsTrends(req("/"), {}, url("/?window=99d"));
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "window");
    assert.equal(
      body.error.message,
      unsupportedWindowMessage("99d", HISTORY_WINDOWS),
    );
  });

  test("aggregates per-day across subnets (sums + weighted/median price)", async () => {
    const env = d1Env({
      "FROM subnet_snapshots": [
        // newest day first (the SQL orders DESC); two subnets contribute.
        {
          snapshot_date: "2026-06-02",
          total_stake_tao: 300,
          alpha_price_tao: 0.02,
          validator_count: 8,
          miner_count: 50,
          emission_share: 0.04,
        },
        {
          snapshot_date: "2026-06-02",
          total_stake_tao: 100,
          alpha_price_tao: 0.06,
          validator_count: 2,
          miner_count: 10,
          emission_share: 0.02,
        },
        {
          snapshot_date: "2026-06-01",
          total_stake_tao: 100,
          alpha_price_tao: 0.01,
          validator_count: 4,
          miner_count: 20,
          emission_share: 0.03,
        },
      ],
    });
    const body = await json(
      await handleEconomicsTrends(req("/"), env, url("/?window=7d")),
    );
    assert.equal(body.data.window, "7d");
    assert.equal(body.data.day_count, 2);
    // Newest-first order preserved from the query.
    const [recent, older] = body.data.days;
    assert.equal(recent.snapshot_date, "2026-06-02");
    assert.equal(recent.subnet_count, 2);
    assert.equal(recent.total_stake_tao, 400);
    assert.equal(recent.validator_count, 10);
    assert.equal(recent.miner_count, 60);
    // Stake-weighted mean price: (0.02·300 + 0.06·100) / 400 = 0.03.
    assert.equal(recent.alpha_price_tao_weighted, 0.03);
    // Unweighted median of [0.02, 0.06] = 0.04.
    assert.equal(recent.alpha_price_tao_median, 0.04);
    // Mean emission share: (0.04 + 0.02) / 2 = 0.03.
    assert.equal(recent.mean_emission_share, 0.03);
    assert.equal(older.snapshot_date, "2026-06-01");
    assert.equal(older.subnet_count, 1);
    assert.equal(older.total_stake_tao, 100);
  });

  test("nulls a metric for a day when no subnet reported it", async () => {
    const env = d1Env({
      "FROM subnet_snapshots": [
        {
          snapshot_date: "2026-06-03",
          total_stake_tao: null,
          alpha_price_tao: null,
          validator_count: null,
          miner_count: null,
          emission_share: null,
        },
      ],
    });
    const body = await json(
      await handleEconomicsTrends(req("/"), env, url("/")),
    );
    const [day] = body.data.days;
    assert.equal(day.subnet_count, 1);
    assert.equal(day.total_stake_tao, null);
    assert.equal(day.alpha_price_tao_weighted, null);
    assert.equal(day.alpha_price_tao_median, null);
    assert.equal(day.validator_count, null);
    assert.equal(day.miner_count, null);
    assert.equal(day.mean_emission_share, null);
  });

  test("returns CSV response when ?format=csv is requested", async () => {
    const env = d1Env({
      "FROM subnet_snapshots": [
        {
          snapshot_date: "2026-06-02",
          total_stake_tao: 300,
          alpha_price_tao: 0.02,
          validator_count: 8,
          miner_count: 50,
          emission_share: 0.04,
        },
      ],
    });
    const res = await handleEconomicsTrends(req("/"), env, url("/?format=csv"));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/csv; charset=utf-8");
    assert.ok(
      res.headers
        .get("content-disposition")
        .includes('filename="economics-trends.csv"'),
    );
    const text = await res.text();
    const lines = text.split("\r\n");
    assert.equal(
      lines[0],
      "snapshot_date,subnet_count,total_stake_tao,alpha_price_tao_weighted,alpha_price_tao_median,validator_count,miner_count,mean_emission_share",
    );
    assert.equal(lines[1], "2026-06-02,1,300,0.02,0.02,8,50,0.04");
  });

  test("returns CSV response when Accept: text/csv header is present", async () => {
    const env = d1Env({
      "FROM subnet_snapshots": [
        {
          snapshot_date: "2026-06-02",
          total_stake_tao: 300,
          alpha_price_tao: 0.02,
          validator_count: 8,
          miner_count: 50,
          emission_share: 0.04,
        },
      ],
    });
    const request = new Request("https://api.metagraph.sh/", {
      headers: { accept: "text/csv" },
    });
    const res = await handleEconomicsTrends(request, env, url("/"));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/csv; charset=utf-8");
    const text = await res.text();
    const lines = text.split("\r\n");
    assert.equal(lines[1], "2026-06-02,1,300,0.02,0.02,8,50,0.04");
  });

  test("returns empty/header-only CSV when rollup is cold", async () => {
    const res = await handleEconomicsTrends(req("/"), {}, url("/?format=csv"));
    assert.equal(res.status, 200);
    const text = await res.text();
    const lines = text.split("\r\n");
    assert.equal(
      lines[0],
      "snapshot_date,subnet_count,total_stake_tao,alpha_price_tao_weighted,alpha_price_tao_median,validator_count,miner_count,mean_emission_share",
    );
    assert.equal(lines.length, 1);
  });

  test("rejects an unsupported format value", async () => {
    const res = await handleEconomicsTrends(req("/"), {}, url("/?format=pdf"));
    const body = await errorJson(res);
    assert.equal(res.status, 400);
    assert.equal(body.meta.parameter, "format");
  });

  test("rejects an empty format parameter", async () => {
    const res = await handleEconomicsTrends(req("/"), {}, url("/?format="));
    const body = await errorJson(res);
    assert.equal(res.status, 400);
    assert.equal(body.meta.parameter, "format");
  });

  test("?format=json keeps the JSON envelope even when Accept asks for CSV", async () => {
    const env = d1Env({
      "FROM subnet_snapshots": [
        {
          snapshot_date: "2026-06-02",
          total_stake_tao: 300,
          alpha_price_tao: 0.02,
          validator_count: 8,
          miner_count: 50,
          emission_share: 0.04,
        },
      ],
    });
    const request = new Request("https://api.metagraph.sh/", {
      headers: { accept: "text/csv" },
    });
    const res = await handleEconomicsTrends(request, env, url("/?format=json"));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /application\/json/);
    const body = await res.json();
    assert.equal(body.data.day_count, 1);
  });
});

describe("handleUptime", () => {
  test("defaults window to 90d and returns empty surfaces on cold D1", async () => {
    const body = await json(
      await handleUptime(
        req("/"),
        {},
        NETUID,
        url(`/api/v1/subnets/${NETUID}/uptime`),
      ),
    );
    assert.equal(body.data.netuid, NETUID);
    assert.equal(body.data.window, "90d");
    assert.deepEqual(body.data.surfaces, []);
  });

  test("rejects unknown window values", async () => {
    const res = await handleUptime(req("/"), {}, NETUID, url("/?window=30d"));
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "window");
    assert.equal(
      body.error.message,
      unsupportedWindowMessage("30d", UPTIME_WINDOWS),
    );
  });

  test("rejects duplicate window parameters", async () => {
    const res = await handleUptime(
      req("/"),
      {},
      NETUID,
      url("/?window=90d&window=1y"),
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "window");
  });

  test("aggregates surface_uptime_daily rows for the requested window", async () => {
    const env = d1Env({
      "FROM surface_uptime_daily": [
        {
          surface_id: "sn-7-acme-subnet-api",
          surface_key: "subnet-api",
          day: "2026-06-01",
          samples: 10,
          ok_count: 9,
          uptime_ratio: 0.9,
          avg_latency_ms: 120,
          latency_samples: 10,
          p50: 100,
          p95: 200,
          p99: 250,
          status: "degraded",
        },
      ],
    });
    const body = await json(
      await handleUptime(req("/"), env, NETUID, url("/?window=1y")),
    );
    assert.equal(body.data.window, "1y");
    assert.equal(body.data.surfaces.length, 1);
    assert.equal(body.data.surfaces[0].surface_id, "sn-7-acme-subnet-api");
    assert.equal(body.data.surfaces[0].days[0].uptime_ratio, 0.9);
  });
});

describe("handleLeaderboards", () => {
  test("returns all boards with empty D1 projections on cold store", async () => {
    const env = createLocalArtifactEnv();
    const body = await json(
      await handleLeaderboards(
        req("/api/v1/registry/leaderboards"),
        env,
        url("/api/v1/registry/leaderboards"),
      ),
    );
    assert.ok(typeof body.data.boards === "object");
    assert.ok(Object.keys(body.data.boards).length > 0);
    assert.equal(body.meta.source, "registry+live-cron-prober");
  });

  test("rejects unknown board names", async () => {
    const env = createLocalArtifactEnv();
    const res = await handleLeaderboards(
      req("/"),
      env,
      url("/?board=not-a-board"),
    );
    const body = await errorJson(res);
    assert.match(body.error.message, /Unknown board/);
  });

  test("rejects out-of-range limit values", async () => {
    const env = createLocalArtifactEnv();
    const res = await handleLeaderboards(req("/"), env, url("/?limit=1000"));
    const body = await errorJson(res);
    assert.match(body.error.message, /limit must be an integer/);
  });

  test("filters to a single board when requested", async () => {
    const env = createLocalArtifactEnv();
    const body = await json(
      await handleLeaderboards(
        req("/"),
        env,
        url("/?board=most-complete&limit=5"),
      ),
    );
    assert.equal(body.data.board, "most-complete");
    assert.ok(Array.isArray(body.data.boards["most-complete"]));
  });

  test("uses surface uptime rollups for most-reliable board", async () => {
    const env = d1Env({
      "FROM surface_uptime_daily": [
        {
          netuid: 7,
          samples: 10,
          ok_count: 9,
          avg_latency_ms: 100,
          latency_samples: 10,
        },
      ],
    });
    const body = await json(
      await handleLeaderboards(
        req("/"),
        env,
        url("/?board=most-reliable&limit=5"),
      ),
    );
    assert.equal(body.data.board, "most-reliable");
    assert.equal(body.data.boards["most-reliable"].length, 1);
    assert.equal(body.data.boards["most-reliable"][0].netuid, 7);
  });

  test("healthiest SQL averages only ok surface_status latencies", async () => {
    const surfaceStatusSql = [];
    const env = {
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind() {
              return {
                async all() {
                  if (/FROM surface_status/.test(sql)) {
                    surfaceStatusSql.push(sql);
                    return {
                      results: [
                        {
                          netuid: 1,
                          total: 2,
                          ok_count: 1,
                          avg_latency_ms: 100,
                        },
                      ],
                    };
                  }
                  return { results: [] };
                },
              };
            },
          };
        },
      },
    };
    await json(
      await handleLeaderboards(
        req("/"),
        env,
        url("/?board=healthiest&limit=5"),
      ),
    );
    const healthSql = surfaceStatusSql.find((sql) =>
      /SUM\(CASE WHEN status = 'ok'/.test(sql),
    );
    assert.ok(
      healthSql,
      "expected leaderboards healthRows surface_status query",
    );
    assert.match(healthSql, /status = 'ok'/);
    assert.match(healthSql, /AVG\(CASE WHEN/);
    assert.doesNotMatch(healthSql, /AVG\(latency_ms\)/);
  });

  test("fastest-growing latches growth from the first non-null completeness score", async () => {
    const env = d1Env({
      "WHERE snapshot_date >= \\?": [
        { netuid: 9, snapshot_date: "2026-06-03", completeness_score: null },
        { netuid: 9, snapshot_date: "2026-06-06", completeness_score: 80 },
        { netuid: 9, snapshot_date: "2026-06-10", completeness_score: 85 },
      ],
    });
    const body = await json(
      await handleLeaderboards(
        req("/"),
        env,
        url("/?board=fastest-growing&limit=5"),
      ),
    );
    const entry = body.data.boards["fastest-growing"].find(
      (e) => e.netuid === 9,
    );
    assert.ok(entry, "leading-null subnet must rank once real scores exist");
    assert.equal(entry.completeness_delta, 5);
  });
});

describe("handleCompare", () => {
  test("requires netuids", async () => {
    const env = createLocalArtifactEnv();
    const res = await handleCompare(req("/"), env, url("/api/v1/compare"));
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "netuids");
  });

  test("rejects unknown dimensions", async () => {
    const env = createLocalArtifactEnv();
    const res = await handleCompare(
      req("/"),
      env,
      url("/api/v1/compare?netuids=1&dimensions=structure,bogus"),
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "dimensions");
  });

  test("composes structure-only compare for known netuids", async () => {
    const env = createLocalArtifactEnv();
    const body = await json(
      await handleCompare(
        req("/"),
        env,
        url("/api/v1/compare?netuids=1,7&dimensions=structure"),
      ),
    );
    assert.deepEqual(body.data.requested_netuids, [1, 7]);
    assert.deepEqual(body.data.dimensions, ["structure"]);
    assert.equal(body.data.subnets.length, 2);
    for (const subnet of body.data.subnets) {
      assert.equal("structure" in subnet, true);
      assert.equal("economics" in subnet, false);
      assert.equal("health" in subnet, false);
    }
  });

  test("deduplicates repeated netuids in request order", async () => {
    const env = createLocalArtifactEnv();
    const body = await json(
      await handleCompare(req("/"), env, url("/api/v1/compare?netuids=1,1,7")),
    );
    assert.deepEqual(body.data.requested_netuids, [1, 7]);
  });
});

describe("composeCompareData", () => {
  test("keeps requested netuid order and marks unknown subnets found:false", () => {
    const data = composeCompareData({
      requestedNetuids: [1, 99999],
      dimensions: ["structure"],
      subnetMeta: new Map([[1, { name: "Apex", slug: "apex" }]]),
      structureRows: [
        {
          netuid: 1,
          completeness_score: 80,
          surface_count: 5,
          operational_interface_count: 2,
        },
      ],
      economicsRows: [],
      healthRows: [],
      observedAt: OBSERVED_AT,
    });
    assert.deepEqual(data.requested_netuids, [1, 99999]);
    assert.equal(data.subnets[0].found, true);
    assert.equal(data.subnets[1].found, false);
    assert.equal(data.subnets[1].structure, null);
  });
});

describe("canonicalCompareCachePath", () => {
  test("normalizes netuids and omits default dimensions from the cache key", () => {
    const path = canonicalCompareCachePath(
      url("/api/v1/compare?netuids=7,1&dimensions=structure,economics,health"),
    );
    assert.equal(path, "/api/v1/compare?netuids=7%2C1");
  });

  test("returns null for invalid compare queries", () => {
    assert.equal(
      canonicalCompareCachePath(url("/api/v1/compare?netuids=not-valid")),
      null,
    );
  });
});

describe("canonicalUptimeCachePath", () => {
  test("normalizes bare path to explicit default window", () => {
    assert.equal(
      canonicalUptimeCachePath(url("/api/v1/subnets/7/uptime")),
      "/api/v1/subnets/7/uptime?window=90d",
    );
  });

  test("explicit ?window=90d collapses to same key as bare path", () => {
    assert.equal(
      canonicalUptimeCachePath(url("/api/v1/subnets/7/uptime?window=90d")),
      "/api/v1/subnets/7/uptime?window=90d",
    );
  });

  test("preserves valid non-default window", () => {
    assert.equal(
      canonicalUptimeCachePath(url("/api/v1/subnets/7/uptime?window=1y")),
      "/api/v1/subnets/7/uptime?window=1y",
    );
  });

  test("falls back to raw search on unknown query param", () => {
    const raw = "/api/v1/subnets/7/uptime?unknown=x";
    assert.equal(canonicalUptimeCachePath(url(raw)), raw);
  });

  test("falls back to raw search on invalid window value", () => {
    const raw = "/api/v1/subnets/7/uptime?window=7d";
    assert.equal(canonicalUptimeCachePath(url(raw)), raw);
  });
});

describe("canonicalEconomicsTrendsCachePath", () => {
  test("normalizes bare path to explicit default window", () => {
    assert.equal(
      canonicalEconomicsTrendsCachePath(url("/api/v1/economics/trends")),
      "/api/v1/economics/trends?window=30d",
    );
  });

  test("explicit ?window=30d collapses to same key as bare path", () => {
    assert.equal(
      canonicalEconomicsTrendsCachePath(
        url("/api/v1/economics/trends?window=30d"),
      ),
      "/api/v1/economics/trends?window=30d",
    );
  });

  test("preserves valid non-default window", () => {
    assert.equal(
      canonicalEconomicsTrendsCachePath(
        url("/api/v1/economics/trends?window=7d"),
      ),
      "/api/v1/economics/trends?window=7d",
    );
  });

  test("falls back to raw search on unknown query param", () => {
    const raw = "/api/v1/economics/trends?unknown=x";
    assert.equal(canonicalEconomicsTrendsCachePath(url(raw)), raw);
  });

  test("falls back to raw search on invalid window value", () => {
    const raw = "/api/v1/economics/trends?window=bogus";
    assert.equal(canonicalEconomicsTrendsCachePath(url(raw)), raw);
  });

  test("adds format=csv to the cache key when CSV is requested", () => {
    assert.equal(
      canonicalEconomicsTrendsCachePath(
        url("/api/v1/economics/trends?window=7d&format=csv"),
      ),
      "/api/v1/economics/trends?window=7d&format=csv",
    );
  });

  test("explicit CSV and JSON format overrides produce distinct cache variants", () => {
    const csv = canonicalEconomicsTrendsCachePath(
      url("/api/v1/economics/trends?format=csv"),
    );
    assert.equal(csv, "/api/v1/economics/trends?window=30d&format=csv");

    const csvAccept = new Request("https://api.metagraph.sh/", {
      headers: { accept: "text/csv" },
    });
    const json = canonicalEconomicsTrendsCachePath(
      url("/api/v1/economics/trends?format=json"),
      csvAccept,
    );
    assert.equal(json, "/api/v1/economics/trends?window=30d");
  });

  test("adds format=csv when only Accept: text/csv is present", () => {
    const csvAccept = new Request("https://api.metagraph.sh/", {
      headers: { accept: "text/csv" },
    });
    assert.equal(
      canonicalEconomicsTrendsCachePath(
        url("/api/v1/economics/trends?window=7d"),
        csvAccept,
      ),
      "/api/v1/economics/trends?window=7d&format=csv",
    );
  });

  test("falls back to raw search on invalid format", () => {
    const raw = "/api/v1/economics/trends?format=pdf";
    assert.equal(canonicalEconomicsTrendsCachePath(url(raw)), raw);
  });
});

describe("canonicalLeaderboardsCachePath", () => {
  test("normalizes bare path to explicit default limit", () => {
    assert.equal(
      canonicalLeaderboardsCachePath(url("/api/v1/registry/leaderboards")),
      "/api/v1/registry/leaderboards?limit=20",
    );
  });

  test("explicit ?limit=20 collapses to same key as bare path", () => {
    assert.equal(
      canonicalLeaderboardsCachePath(
        url("/api/v1/registry/leaderboards?limit=20"),
      ),
      "/api/v1/registry/leaderboards?limit=20",
    );
  });

  test("preserves valid board + non-default limit", () => {
    assert.equal(
      canonicalLeaderboardsCachePath(
        url("/api/v1/registry/leaderboards?board=healthiest&limit=10"),
      ),
      "/api/v1/registry/leaderboards?board=healthiest&limit=10",
    );
  });

  test("falls back to raw search on invalid limit", () => {
    const raw = "/api/v1/registry/leaderboards?limit=0";
    assert.equal(canonicalLeaderboardsCachePath(url(raw)), raw);
  });

  test("falls back to raw search on unknown board", () => {
    const raw = "/api/v1/registry/leaderboards?board=not-a-board";
    assert.equal(canonicalLeaderboardsCachePath(url(raw)), raw);
  });
});

describe("configureAnalyticsRoutes", () => {
  test("throws when handlers run before wiring", async () => {
    configureAnalyticsRoutes({
      readHealthMetaKv: null,
      readEconomicsCurrentKv: null,
    });
    // Restore invalid stubs that throw on invocation.
    configureAnalyticsRoutes({
      readHealthMetaKv: () => {
        throw new Error("not wired");
      },
      readEconomicsCurrentKv: () => {
        throw new Error("not wired");
      },
    });
    await assert.rejects(
      () => handleUptime(req("/"), {}, NETUID, url("/?window=90d")),
      /not wired/,
    );
    configureAnalyticsRoutes({
      readHealthMetaKv: async () => ({ last_run_at: OBSERVED_AT }),
      readEconomicsCurrentKv: async () => null,
    });
  });
});
