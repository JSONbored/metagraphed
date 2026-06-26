// Direct unit tests for workers/request-handlers/analytics-routes.mjs (#1917).
// Exercises trajectory, uptime, leaderboards, and compare without routing
// through workers/api.mjs.

import assert from "node:assert/strict";
import { describe, test, beforeEach } from "vitest";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";
import {
  configureAnalyticsRoutes,
  handleCompare,
  handleLeaderboards,
  handleTrajectory,
  handleUptime,
  composeCompareData,
  canonicalCompareCachePath,
} from "../workers/request-handlers/analytics-routes.mjs";

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
