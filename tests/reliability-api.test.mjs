import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";
import {
  formatReliabilityScorecard,
  loadReliabilityScorecard,
} from "../src/health-serving.mjs";
import { handleRequest } from "../workers/api.mjs";

const req = (path) => new Request(`https://api.metagraph.sh${path}`);

function d1With(rows) {
  return {
    prepare(_sql) {
      return {
        bind(...args) {
          this.args = args;
          return this;
        },
        async all() {
          const netuid = Number(this.args?.[0]);
          const filtered = rows.filter(
            (row) => row.netuid == null || row.netuid === netuid,
          );
          return { results: filtered.map(({ netuid: _n, ...row }) => row) };
        },
      };
    },
  };
}

function kvWith(entries) {
  return {
    async get(key, opts) {
      if (!(key in entries)) return null;
      return opts?.type === "json"
        ? entries[key]
        : JSON.stringify(entries[key]);
    },
  };
}

describe("formatReliabilityScorecard", () => {
  test("returns scored subnet + per-surface rollup without daily series", () => {
    const out = formatReliabilityScorecard({
      netuid: 7,
      window: "30d",
      observedAt: "2026-06-22T01:00:00.000Z",
      rows: [
        {
          surface_id: "7:subnet-api:x",
          day: "2026-06-12",
          samples: 720,
          ok_count: 720,
          avg_latency_ms: 200,
        },
        {
          surface_id: "7:docs:y",
          day: "2026-06-12",
          samples: 720,
          ok_count: 360,
          avg_latency_ms: 900,
        },
      ],
      now: "2026-06-13T00:00:00.000Z",
    });
    assert.equal(out.schema_version, 1);
    assert.equal(out.netuid, 7);
    assert.equal(out.window, "30d");
    assert.equal(out.observed_at, "2026-06-22T01:00:00.000Z");
    assert.equal(out.source, "live-cron-prober");
    assert.equal(out.reliability.score, 75);
    assert.equal(out.surfaces.length, 2);
    assert.equal(out.surfaces[0].surface_id, "7:docs:y");
    assert.equal(out.surfaces[1].surface_id, "7:subnet-api:x");
    assert.equal("days" in out.surfaces[0], false);
    assert.equal(out.summary.surface_count, 2);
    assert.equal(out.summary.grade_histogram.A, 1);
  });

  test("null subnet reliability when there is no probe history", () => {
    const out = formatReliabilityScorecard({
      netuid: 3,
      window: "7d",
      rows: [],
    });
    assert.equal(out.reliability, null);
    assert.deepEqual(out.surfaces, []);
  });
});

describe("GET /api/v1/subnets/{netuid}/reliability", () => {
  test("serves the live reliability scorecard from D1", async () => {
    const RUN = "2026-06-22T01:00:00.000Z";
    const env = createLocalArtifactEnv({
      METAGRAPH_HEALTH_DB: d1With([
        {
          netuid: 7,
          surface_id: "7:subnet-api:x",
          day: "2026-06-13",
          samples: 700,
          ok_count: 700,
          avg_latency_ms: 40,
        },
      ]),
      METAGRAPH_CONTROL: kvWith({ "health:meta": { last_run_at: RUN } }),
    });
    const res = await handleRequest(
      req("/api/v1/subnets/7/reliability?window=90d"),
      env,
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.netuid, 7);
    assert.equal(body.data.window, "90d");
    assert.equal(body.data.observed_at, RUN);
    assert.equal(body.data.reliability.score, 100);
    assert.equal(body.data.surfaces[0].surface_id, "7:subnet-api:x");
    assert.equal(body.meta.source, "live-cron-prober");
    assert.equal(body.meta.generated_at, RUN);
    assert.equal("days" in body.data.surfaces[0], false);
  });

  test("defaults to 30d and returns null reliability when D1 is cold", async () => {
    const env = createLocalArtifactEnv();
    const res = await handleRequest(
      req("/api/v1/subnets/7/reliability"),
      env,
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.window, "30d");
    assert.equal(body.data.reliability, null);
    assert.deepEqual(body.data.surfaces, []);
  });

  test("rejects an invalid window with 400", async () => {
    const env = createLocalArtifactEnv();
    for (const windowParam of ["1y", "5y", "constructor"]) {
      const res = await handleRequest(
        req(`/api/v1/subnets/7/reliability?window=${windowParam}`),
        env,
        {},
      );
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error.code, "invalid_query");
    }
  });

  test("rejects unknown query parameters", async () => {
    const env = createLocalArtifactEnv();
    const res = await handleRequest(
      req("/api/v1/subnets/7/reliability?foo=bar"),
      env,
      {},
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "invalid_query");
  });
});

describe("loadReliabilityScorecard (D1-backed)", () => {
  test("returns null reliability when D1 is cold", async () => {
    const out = await loadReliabilityScorecard({
      d1: async () => [],
      netuid: 7,
    });
    assert.equal(out.reliability, null);
    assert.deepEqual(out.surfaces, []);
  });

  test("scores rows from surface_uptime_daily", async () => {
    const out = await loadReliabilityScorecard({
      d1: async () => [
        {
          surface_id: "7:subnet-api:x",
          day: "2026-06-12",
          samples: 100,
          ok_count: 100,
          avg_latency_ms: 100,
        },
      ],
      netuid: 7,
      windowDays: 7,
      now: "2026-06-13T00:00:00.000Z",
    });
    assert.equal(out.window, "7d");
    assert.equal(out.reliability.score, 100);
    assert.equal(out.surfaces.length, 1);
  });

  test("returns empty scorecard (not throw) when the query fails", async () => {
    const out = await loadReliabilityScorecard({
      d1: async () => {
        throw new Error("d1 down");
      },
      netuid: 7,
    });
    assert.equal(out.reliability, null);
  });
});
