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
  canonicalTrajectoryCachePath,
  canonicalUptimeCachePath,
  composeCompareData,
  configureAnalyticsRoutes,
  handleCompare,
  handleCompareValidators,
  handleEconomicsTrends,
  handleLeaderboards,
  handleTrajectory,
  handleUptime,
} from "../workers/request-handlers/analytics-routes.mjs";
import { MCP_TOOLS } from "../src/mcp-server.mjs";
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

  test("returns CSV response when ?format=csv is present", async () => {
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
    const res = await handleTrajectory(
      req("/"),
      env,
      NETUID,
      url("/?format=csv"),
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/csv; charset=utf-8");
    assert.ok(
      res.headers
        .get("content-disposition")
        .includes('filename="subnet-7-trajectory.csv"'),
    );
    const text = await res.text();
    const lines = text.split("\r\n");
    assert.equal(
      lines[0],
      "date,completeness_score,surface_count,endpoint_count,validator_count,miner_count,total_stake_tao,alpha_price_tao,emission_share,tao_in_pool_tao,alpha_in_pool,alpha_out_pool,subnet_volume_tao",
    );
    assert.equal(lines[1], "2026-06-01,35,1,1,8,60,90,0.01,0.02,,,,");
    assert.equal(lines[2], "2026-06-02,40,2,1,8,64,100,0.01,0.02,,,,");
  });

  test("returns CSV response when Accept: text/csv header is present", async () => {
    const env = d1Env({
      "FROM subnet_snapshots": [
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
    const request = new Request("https://api.metagraph.sh/", {
      headers: { accept: "text/csv" },
    });
    const res = await handleTrajectory(request, env, NETUID, url("/"));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/csv; charset=utf-8");
    const text = await res.text();
    const lines = text.split("\r\n");
    assert.equal(lines[1], "2026-06-01,35,1,1,8,60,90,0.01,0.02,,,,");
  });

  test("returns header-only CSV when D1 is cold", async () => {
    const res = await handleTrajectory(
      req("/"),
      {},
      NETUID,
      url("/?format=csv"),
    );
    assert.equal(res.status, 200);
    const text = await res.text();
    const lines = text.split("\r\n");
    assert.equal(
      lines[0],
      "date,completeness_score,surface_count,endpoint_count,validator_count,miner_count,total_stake_tao,alpha_price_tao,emission_share,tao_in_pool_tao,alpha_in_pool,alpha_out_pool,subnet_volume_tao",
    );
    assert.equal(lines.length, 1);
  });

  test("rejects an unsupported format value", async () => {
    const res = await handleTrajectory(
      req("/"),
      {},
      NETUID,
      url("/?format=pdf"),
    );
    const body = await errorJson(res);
    assert.equal(res.status, 400);
    assert.equal(body.meta.parameter, "format");
  });

  test("rejects an empty format parameter", async () => {
    const res = await handleTrajectory(req("/"), {}, NETUID, url("/?format="));
    const body = await errorJson(res);
    assert.equal(res.status, 400);
    assert.equal(body.meta.parameter, "format");
  });

  test("?format=json keeps the JSON envelope even when Accept asks for CSV", async () => {
    const env = d1Env({
      "FROM subnet_snapshots": [
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
    const request = new Request("https://api.metagraph.sh/", {
      headers: { accept: "text/csv" },
    });
    const res = await handleTrajectory(
      request,
      env,
      NETUID,
      url("/?format=json"),
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /application\/json/);
    const body = await res.json();
    assert.equal(body.data.point_count, 1);
  });

  // #4832 gap-closure: METAGRAPH_SUBNET_SNAPSHOTS_SOURCE is a NEW flag,
  // deliberately left unset in wrangler.jsonc (no historical backfill --
  // see handleTrajectory's own header comment) -- these tests only prove
  // the wiring, not a live flip.
  test("flag=postgres serves the DATA_API response, D1 never queried", async () => {
    let d1Called = false;
    const env = d1Env();
    env.METAGRAPH_HEALTH_DB.prepare = () => {
      d1Called = true;
      throw new Error(
        "D1 must not be queried when Postgres serves the request",
      );
    };
    env.METAGRAPH_SUBNET_SNAPSHOTS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({
          schema_version: 1,
          netuid: NETUID,
          points: [],
          point_count: 0,
        }),
    };
    const res = await handleTrajectory(
      req(`/api/v1/subnets/${NETUID}/trajectory`),
      env,
      NETUID,
      url(`/api/v1/subnets/${NETUID}/trajectory`),
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.netuid, NETUID);
    assert.equal(d1Called, false);
  });

  test("flag=postgres falls back to D1 when DATA_API fails", async () => {
    const env = d1Env();
    env.METAGRAPH_SUBNET_SNAPSHOTS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () => {
        throw new Error("boom");
      },
    };
    const res = await handleTrajectory(
      req(`/api/v1/subnets/${NETUID}/trajectory`),
      env,
      NETUID,
      url(`/api/v1/subnets/${NETUID}/trajectory`),
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.data.points, []);
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
    assert.equal(recent.total_stake_tao, "400.000000000");
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
    assert.equal(older.total_stake_tao, "100.000000000");
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
    assert.equal(lines[1], "2026-06-02,1,300.000000000,0.02,0.02,8,50,0.04");
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
    assert.equal(lines[1], "2026-06-02,1,300.000000000,0.02,0.02,8,50,0.04");
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

  // #4832 gap-closure: reuses METAGRAPH_SUBNET_SNAPSHOTS_SOURCE, same table
  // and same deliberately-unflipped rationale as handleTrajectory above.
  test("flag=postgres serves the DATA_API response, D1 never queried", async () => {
    let d1Called = false;
    const env = d1Env();
    env.METAGRAPH_HEALTH_DB.prepare = () => {
      d1Called = true;
      throw new Error(
        "D1 must not be queried when Postgres serves the request",
      );
    };
    env.METAGRAPH_SUBNET_SNAPSHOTS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ schema_version: 1, day_count: 0, days: [] }),
    };
    const res = await handleEconomicsTrends(
      req("/api/v1/economics/trends"),
      env,
      url("/api/v1/economics/trends"),
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.day_count, 0);
    assert.equal(d1Called, false);
  });

  test("flag=postgres falls back to D1 when DATA_API fails", async () => {
    const env = d1Env();
    env.METAGRAPH_SUBNET_SNAPSHOTS_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () => {
        throw new Error("boom");
      },
    };
    const res = await handleEconomicsTrends(
      req("/api/v1/economics/trends"),
      env,
      url("/api/v1/economics/trends"),
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.data.days, []);
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

  // #4832 gap-closure: METAGRAPH_HEALTH_SOURCE is a NEW flag, deliberately
  // left unset in wrangler.jsonc (see handleBulkHealthTrends' own header
  // comment in analytics.mjs) -- these tests only prove the wiring, not a
  // live flip.
  test("flag=postgres serves the DATA_API response, D1 never queried", async () => {
    let d1Called = false;
    const env = d1Env();
    env.METAGRAPH_HEALTH_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({ netuid: NETUID, window: "90d", surfaces: [] }),
    };
    env.METAGRAPH_HEALTH_DB.prepare = () => {
      d1Called = true;
      throw new Error(
        "D1 must not be queried when Postgres serves the request",
      );
    };
    const body = await json(
      await handleUptime(
        req(`/api/v1/subnets/${NETUID}/uptime`),
        env,
        NETUID,
        url(`/api/v1/subnets/${NETUID}/uptime`),
      ),
    );
    assert.equal(body.data.netuid, NETUID);
    assert.deepEqual(body.data.surfaces, []);
    assert.equal(d1Called, false);
  });

  test("flag=postgres falls back to D1 when DATA_API fails", async () => {
    const env = d1Env();
    env.METAGRAPH_HEALTH_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () => {
        throw new Error("boom");
      },
    };
    const body = await json(
      await handleUptime(
        req(`/api/v1/subnets/${NETUID}/uptime`),
        env,
        NETUID,
        url(`/api/v1/subnets/${NETUID}/uptime`),
      ),
    );
    assert.equal(body.data.netuid, NETUID);
    assert.deepEqual(body.data.surfaces, []);
  });

  test("returns CSV response when ?format=csv is present, flattening surfaces into one row per (surface, day)", async () => {
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
    const res = await handleUptime(
      req("/"),
      env,
      NETUID,
      url("/?window=1y&format=csv"),
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/csv; charset=utf-8");
    assert.ok(
      res.headers
        .get("content-disposition")
        .includes(`filename="subnet-${NETUID}-uptime.csv"`),
    );
    const lines = (await res.text()).split("\r\n");
    assert.equal(
      lines[0],
      "surface_id,day,samples,uptime_ratio,avg_latency_ms,latency_sample_count,p50,p95,p99,status",
    );
    assert.equal(
      lines[1],
      "sn-7-acme-subnet-api,2026-06-01,10,0.9,120,10,100,200,250,degraded",
    );
  });

  test("returns CSV response when Accept: text/csv header is present", async () => {
    const env = d1Env({
      "FROM surface_uptime_daily": [
        {
          surface_id: "sn-7-acme-subnet-api",
          surface_key: "subnet-api",
          day: "2026-06-01",
          samples: 10,
          ok_count: 9,
          avg_latency_ms: 120,
          latency_samples: 10,
          p50: 100,
          p95: 200,
          p99: 250,
          status: "ok",
        },
      ],
    });
    const request = new Request("https://api.metagraph.sh/", {
      headers: { accept: "text/csv" },
    });
    const res = await handleUptime(request, env, NETUID, url("/"));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/csv; charset=utf-8");
  });

  test("returns a header-only CSV on cold D1, with no surfaces to flatten", async () => {
    const res = await handleUptime(req("/"), {}, NETUID, url("/?format=csv"));
    assert.equal(res.status, 200);
    const lines = (await res.text()).split("\r\n");
    assert.equal(
      lines[0],
      "surface_id,day,samples,uptime_ratio,avg_latency_ms,latency_sample_count,p50,p95,p99,status",
    );
    assert.equal(lines.length, 1);
  });

  test("rejects an unsupported format value", async () => {
    const res = await handleUptime(req("/"), {}, NETUID, url("/?format=pdf"));
    const body = await errorJson(res);
    assert.equal(res.status, 400);
    assert.equal(body.meta.parameter, "format");
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

  // #5555: a leading-zero limit like 007 must be rejected the same way every
  // other analytics route rejects it (shared parseLimitParam, /^[1-9]\d*$/),
  // not silently accepted because Number("007") === 7 is in range.
  test("rejects a leading-zero limit like 007", async () => {
    const env = createLocalArtifactEnv();
    const res = await handleLeaderboards(req("/"), env, url("/?limit=007"));
    assert.equal(res.status, 400);
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

  // #4832 gap-closure: handleCompare has no single D1 route to forward, so
  // its health dimension synthesizes its own /api/v1/internal/compare-health
  // request rather than reusing tryPostgresTier's usual "forward the caller's
  // request unchanged" contract -- these tests prove that wiring in
  // isolation (D1 called or not), same reused METAGRAPH_HEALTH_SOURCE flag
  // as handleUptime above.
  test("health dimension: flag=postgres serves the DATA_API response, D1 never queried", async () => {
    let d1Called = false;
    const env = createLocalArtifactEnv();
    env.METAGRAPH_HEALTH_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () =>
        Response.json({
          rows: [
            { netuid: 7, surface_count: 3, ok_count: 2, avg_latency_ms: 120 },
          ],
        }),
    };
    env.METAGRAPH_HEALTH_DB = {
      prepare() {
        d1Called = true;
        throw new Error(
          "D1 must not be queried when Postgres serves the request",
        );
      },
    };
    const body = await json(
      await handleCompare(
        req("/api/v1/compare"),
        env,
        url("/api/v1/compare?netuids=7&dimensions=health"),
      ),
    );
    assert.equal(body.data.subnets[0].netuid, 7);
    assert.equal(d1Called, false);
  });

  test("health dimension: flag=postgres falls back to D1 when DATA_API fails", async () => {
    let d1Called = false;
    const env = createLocalArtifactEnv();
    env.METAGRAPH_HEALTH_SOURCE = "postgres";
    env.DATA_API = {
      fetch: async () => {
        throw new Error("boom");
      },
    };
    const baseEnv = d1Env({
      "FROM surface_status": [
        { netuid: 7, surface_count: 5, ok_count: 4, avg_latency_ms: 90 },
      ],
    });
    env.METAGRAPH_HEALTH_DB = {
      prepare(sqlText) {
        d1Called = true;
        return baseEnv.METAGRAPH_HEALTH_DB.prepare(sqlText);
      },
    };
    const body = await json(
      await handleCompare(
        req("/api/v1/compare"),
        env,
        url("/api/v1/compare?netuids=7&dimensions=health"),
      ),
    );
    assert.equal(body.data.subnets[0].netuid, 7);
    assert.equal(d1Called, true);
  });
});

describe("handleCompareValidators", () => {
  const HOTKEY_A = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";
  const HOTKEY_B = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

  test("requires hotkeys", async () => {
    const env = createLocalArtifactEnv();
    const res = await handleCompareValidators(
      req("/"),
      env,
      url("/api/v1/compare/validators"),
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "hotkeys");
  });

  test("rejects a malformed hotkeys list", async () => {
    const env = createLocalArtifactEnv();
    const res = await handleCompareValidators(
      req("/"),
      env,
      url("/api/v1/compare/validators?hotkeys=not-a-valid-address"),
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "hotkeys");
  });

  test("rejects a malformed netuid", async () => {
    const env = createLocalArtifactEnv();
    const res = await handleCompareValidators(
      req("/"),
      env,
      url(`/api/v1/compare/validators?hotkeys=${HOTKEY_A}&netuid=bogus`),
    );
    const body = await errorJson(res);
    assert.equal(body.meta.parameter, "netuid");
  });

  test("cold store: composes a zeroed comparison, never 404, in request order", async () => {
    const env = createLocalArtifactEnv();
    const body = await json(
      await handleCompareValidators(
        req("/"),
        env,
        url(`/api/v1/compare/validators?hotkeys=${HOTKEY_A},${HOTKEY_B}`),
      ),
    );
    assert.equal(body.data.netuid, null);
    assert.equal(body.data.validator_count, 2);
    assert.deepEqual(
      body.data.validators.map((v) => v.hotkey),
      [HOTKEY_A, HOTKEY_B],
    );
    for (const validator of body.data.validators) {
      assert.equal(validator.subnet_count, 0);
      assert.equal(validator.subnet_context, null);
    }
  });

  test("deduplicates repeated hotkeys in request order", async () => {
    const env = createLocalArtifactEnv();
    const body = await json(
      await handleCompareValidators(
        req("/"),
        env,
        url(
          `/api/v1/compare/validators?hotkeys=${HOTKEY_A},${HOTKEY_B},${HOTKEY_A}`,
        ),
      ),
    );
    assert.deepEqual(
      body.data.validators.map((v) => v.hotkey),
      [HOTKEY_A, HOTKEY_B],
    );
  });

  test("netuid context: flag=postgres carries subnet_context from the per-hotkey Postgres response", async () => {
    const env = createLocalArtifactEnv();
    env.METAGRAPH_NEURONS_SOURCE = "postgres";
    const requestedPaths = [];
    env.DATA_API = {
      fetch: async (request) => {
        const reqUrl = new URL(request.url);
        requestedPaths.push(reqUrl.pathname);
        return Response.json({
          schema_version: 1,
          hotkey: reqUrl.pathname.split("/").pop(),
          coldkey: "coldkey-1",
          subnet_count: 1,
          subnets: [{ netuid: 7, uid: 3, stake_tao: 100 }],
        });
      },
    };
    const body = await json(
      await handleCompareValidators(
        req("/"),
        env,
        url(`/api/v1/compare/validators?hotkeys=${HOTKEY_A}&netuid=7`),
      ),
    );
    assert.deepEqual(requestedPaths, [`/api/v1/validators/${HOTKEY_A}`]);
    assert.equal(body.data.netuid, 7);
    assert.equal(body.data.validators[0].subnet_context.netuid, 7);
    assert.equal(body.data.validators[0].subnet_context.uid, 3);
  });

  test("generated_at tracks the latest captured_at across mixed-order per-hotkey responses", async () => {
    const env = createLocalArtifactEnv();
    env.METAGRAPH_NEURONS_SOURCE = "postgres";
    const HOTKEY_C = "5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy";
    const capturedAtByHotkey = {
      [HOTKEY_A]: "2026-06-20T00:00:00.000Z",
      [HOTKEY_B]: "2026-06-19T00:00:00.000Z", // earlier -- must not overwrite
      [HOTKEY_C]: "2026-06-22T00:00:00.000Z", // later -- must overwrite
    };
    env.DATA_API = {
      fetch: async (request) => {
        const hotkey = new URL(request.url).pathname.split("/").pop();
        return Response.json({
          schema_version: 1,
          hotkey,
          captured_at: capturedAtByHotkey[hotkey],
          subnet_count: 0,
          subnets: [],
        });
      },
    };
    const body = await json(
      await handleCompareValidators(
        req("/"),
        env,
        url(
          `/api/v1/compare/validators?hotkeys=${HOTKEY_A},${HOTKEY_B},${HOTKEY_C}`,
        ),
      ),
    );
    assert.equal(body.meta.generated_at, "2026-06-22T00:00:00.000Z");
  });

  // #6325: REST and MCP share the identical composeValidatorComparison
  // projection and the identical tryPostgresTier(METAGRAPH_NEURONS_SOURCE)
  // per-hotkey fallback contract -- this proves it directly rather than only
  // via each surface's own mirrored-but-separate test suite.
  test("REST/MCP parity: identical hotkeys+netuid inputs produce identical data", async () => {
    const restEnv = createLocalArtifactEnv();
    const restBody = await json(
      await handleCompareValidators(
        req("/"),
        restEnv,
        url(
          `/api/v1/compare/validators?hotkeys=${HOTKEY_A},${HOTKEY_B}&netuid=7`,
        ),
      ),
    );

    const compareValidatorsTool = MCP_TOOLS.find(
      (tool) => tool.name === "compare_validators",
    );
    assert.ok(compareValidatorsTool, "compare_validators tool must exist");
    const mcpData = await compareValidatorsTool.handler(
      { hotkeys: [HOTKEY_A, HOTKEY_B], netuid: 7 },
      { env: createLocalArtifactEnv() },
    );

    assert.deepEqual(mcpData, restBody.data);
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

  test("keys on min_samples so distinct thresholds do not share a cache entry", () => {
    // min_samples is a HAVING row-filter: two thresholds return different rows and
    // must NOT collapse to the same cache key (the bug this guards against).
    const strict = canonicalUptimeCachePath(
      url("/api/v1/subnets/7/uptime?min_samples=100"),
    );
    const loose = canonicalUptimeCachePath(
      url("/api/v1/subnets/7/uptime?min_samples=0"),
    );
    assert.equal(strict, "/api/v1/subnets/7/uptime?window=90d&min_samples=100");
    assert.equal(loose, "/api/v1/subnets/7/uptime?window=90d&min_samples=0");
    assert.notEqual(strict, loose);
  });

  test("omits min_samples from the key when the param is absent", () => {
    // A bare request (no filter) keeps the window-only key, distinct from any
    // explicit ?min_samples= request.
    assert.equal(
      canonicalUptimeCachePath(url("/api/v1/subnets/7/uptime?window=1y")),
      "/api/v1/subnets/7/uptime?window=1y",
    );
    assert.notEqual(
      canonicalUptimeCachePath(url("/api/v1/subnets/7/uptime?window=1y")),
      canonicalUptimeCachePath(
        url("/api/v1/subnets/7/uptime?window=1y&min_samples=5"),
      ),
    );
  });

  test("falls back to raw search on an invalid min_samples value", () => {
    const raw = "/api/v1/subnets/7/uptime?min_samples=-1";
    assert.equal(canonicalUptimeCachePath(url(raw)), raw);
  });

  test("falls back to raw search on an unsupported format value", () => {
    const raw = "/api/v1/subnets/7/uptime?format=pdf";
    assert.equal(canonicalUptimeCachePath(url(raw)), raw);
  });

  test("?format=csv gets a distinct cache key from the JSON default", () => {
    const json = canonicalUptimeCachePath(url("/api/v1/subnets/7/uptime"));
    const csv = canonicalUptimeCachePath(
      url("/api/v1/subnets/7/uptime?format=csv"),
    );
    assert.equal(json, "/api/v1/subnets/7/uptime?window=90d");
    assert.equal(csv, "/api/v1/subnets/7/uptime?window=90d&format=csv");
    assert.notEqual(json, csv);
  });

  test("an Accept: text/csv request gets the same cache key as ?format=csv", () => {
    const request = new Request("https://api.metagraph.sh/", {
      headers: { accept: "text/csv" },
    });
    const viaHeader = canonicalUptimeCachePath(
      url("/api/v1/subnets/7/uptime"),
      request,
    );
    const viaParam = canonicalUptimeCachePath(
      url("/api/v1/subnets/7/uptime?format=csv"),
    );
    assert.equal(viaHeader, viaParam);
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

describe("canonicalTrajectoryCachePath", () => {
  test("bare path stays canonical for JSON", () => {
    assert.equal(
      canonicalTrajectoryCachePath(url("/api/v1/subnets/7/trajectory")),
      "/api/v1/subnets/7/trajectory",
    );
  });

  test("adds format=csv to the cache key when CSV is requested", () => {
    assert.equal(
      canonicalTrajectoryCachePath(
        url("/api/v1/subnets/7/trajectory?format=csv"),
      ),
      "/api/v1/subnets/7/trajectory?format=csv",
    );
  });

  test("explicit CSV and JSON format overrides produce distinct cache variants", () => {
    const csv = canonicalTrajectoryCachePath(
      url("/api/v1/subnets/7/trajectory?format=csv"),
    );
    assert.equal(csv, "/api/v1/subnets/7/trajectory?format=csv");

    const csvAccept = new Request("https://api.metagraph.sh/", {
      headers: { accept: "text/csv" },
    });
    const json = canonicalTrajectoryCachePath(
      url("/api/v1/subnets/7/trajectory?format=json"),
      csvAccept,
    );
    assert.equal(json, "/api/v1/subnets/7/trajectory");
  });

  test("adds format=csv when only Accept: text/csv is present", () => {
    const csvAccept = new Request("https://api.metagraph.sh/", {
      headers: { accept: "text/csv" },
    });
    assert.equal(
      canonicalTrajectoryCachePath(
        url("/api/v1/subnets/7/trajectory"),
        csvAccept,
      ),
      "/api/v1/subnets/7/trajectory?format=csv",
    );
  });

  test("falls back to raw search on unknown query param", () => {
    const raw = "/api/v1/subnets/7/trajectory?bogus=1";
    assert.equal(canonicalTrajectoryCachePath(url(raw)), raw);
  });

  test("falls back to raw search on invalid format", () => {
    const raw = "/api/v1/subnets/7/trajectory?format=pdf";
    assert.equal(canonicalTrajectoryCachePath(url(raw)), raw);
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

  // #5555: a leading-zero limit is invalid under the shared parseLimitParam,
  // so it must not be canonicalized into the shared default cache key.
  test("falls back to raw search on a leading-zero limit like 007", () => {
    const raw = "/api/v1/registry/leaderboards?limit=007";
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
