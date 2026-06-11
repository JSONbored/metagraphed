import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildGlobalHealth,
  formatTrends,
  mergeFreshness,
  mergeRpcEndpoints,
  overlayRpcPoolEligibility,
  overlaySubnetHealth,
  subnetBadgeStatus,
} from "../src/health-serving.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";
import { handleRequest } from "../workers/api.mjs";

describe("overlaySubnetHealth", () => {
  test("replaces operational surfaces with live rows; keeps informational static", () => {
    const staticArtifact = {
      schema_version: 1,
      netuid: 7,
      slug: "acme",
      name: "Acme",
      summary: { status: "failed" },
      surfaces: [
        {
          surface_id: "sn7-api",
          kind: "subnet-api",
          status: "failed",
          last_checked: "old",
        },
        {
          surface_id: "sn7-docs",
          kind: "docs",
          status: "ok",
          last_checked: "old",
        },
      ],
    };
    const liveCurrent = {
      last_run_at: "2026-06-11T00:00:00.000Z",
      surfaces: [
        {
          surface_id: "sn7-api",
          netuid: 7,
          kind: "subnet-api",
          status: "ok",
          classification: "live",
          latency_ms: 50,
          last_checked: "2026-06-11T00:00:00.000Z",
          last_ok: "2026-06-11T00:00:00.000Z",
        },
      ],
    };
    const merged = overlaySubnetHealth(staticArtifact, liveCurrent, 7);
    const api = merged.surfaces.find((s) => s.surface_id === "sn7-api");
    const docs = merged.surfaces.find((s) => s.surface_id === "sn7-docs");
    assert.equal(api.status, "ok"); // overlaid live
    assert.equal(api.observed_by, "live-cron-prober");
    assert.equal(docs.status, "ok"); // static, untouched
    assert.equal(merged.summary.status, "ok"); // recomputed over merged set
    assert.equal(merged.summary.ok_count, 2);
    assert.equal(merged.operational_observed_at, "2026-06-11T00:00:00.000Z");
  });

  test("returns null with no live snapshot (caller falls back to static)", () => {
    assert.equal(overlaySubnetHealth({ surfaces: [] }, null, 7), null);
  });
});

describe("buildGlobalHealth", () => {
  test("serves the live operational summary when present", () => {
    const live = {
      generated_at: "g",
      last_run_at: "r",
      summary: { surface_count: 2, status_counts: { ok: 2 } },
      subnets: [{ netuid: 7, status: "ok" }],
    };
    const out = buildGlobalHealth(live, { contract_version: "v" });
    assert.equal(out.scope, "operational");
    assert.equal(out.source, "live-cron-prober");
    assert.deepEqual(out.subnets, [{ netuid: 7, status: "ok" }]);
  });

  test("returns null when cold so the caller serves static", () => {
    assert.equal(buildGlobalHealth(null, { subnets: [] }), null);
  });
});

describe("mergeRpcEndpoints", () => {
  test("overlays live status/eligibility by id", () => {
    const stat = {
      endpoints: [
        { id: "a", status: "ok", pool_eligible: true },
        { id: "b", status: "ok", pool_eligible: true },
      ],
    };
    const live = {
      last_run_at: "r",
      generated_at: "g",
      endpoints: [
        {
          id: "a",
          status: "failed",
          classification: "dead",
          latency_ms: null,
          pool_eligible: false,
        },
      ],
    };
    const merged = mergeRpcEndpoints(stat, live);
    assert.equal(merged.endpoints.find((e) => e.id === "a").status, "failed");
    assert.equal(
      merged.endpoints.find((e) => e.id === "a").pool_eligible,
      false,
    );
    assert.equal(merged.endpoints.find((e) => e.id === "b").status, "ok"); // no live → static
  });
});

describe("overlayRpcPoolEligibility", () => {
  const pool = {
    id: "finney-rpc",
    endpoints: [
      { id: "a", url: "https://a", pool_eligible: true },
      { id: "b", url: "https://b", pool_eligible: true },
    ],
  };
  test("drops endpoints only after 2+ consecutive failures", () => {
    const live = {
      endpoints: [
        { id: "a", status: "failed", consecutive_failures: 1 }, // transient → stays
        { id: "b", status: "failed", consecutive_failures: 3 }, // sustained → drop
      ],
    };
    const out = overlayRpcPoolEligibility(pool, live);
    assert.equal(out.endpoints.find((e) => e.id === "a").pool_eligible, true);
    assert.equal(out.endpoints.find((e) => e.id === "b").pool_eligible, false);
  });
  test("returns the static pool unchanged when live is cold", () => {
    assert.equal(overlayRpcPoolEligibility(pool, null), pool);
  });
});

describe("mergeFreshness", () => {
  test("marks surface-health current + warn from live meta", () => {
    const stat = {
      sources: [
        {
          id: "surface-health",
          as_of: null,
          status: "missing",
          stale_behavior: "block",
        },
        {
          id: "native-subnets",
          as_of: "x",
          status: "captured",
          stale_behavior: "block",
        },
      ],
      summary: {},
    };
    const out = mergeFreshness(stat, {
      last_run_at: "2026-06-11T00:00:00.000Z",
    });
    const sh = out.sources.find((s) => s.id === "surface-health");
    assert.equal(sh.as_of, "2026-06-11T00:00:00.000Z");
    assert.equal(sh.status, "current");
    assert.equal(sh.stale_behavior, "warn");
    // Other blocking sources are untouched.
    assert.equal(
      out.sources.find((s) => s.id === "native-subnets").stale_behavior,
      "block",
    );
    assert.equal(out.summary.health_probe_as_of, "2026-06-11T00:00:00.000Z");
  });
});

describe("formatTrends", () => {
  test("computes uptime_ratio + avg latency per window", () => {
    const out = formatTrends({
      netuid: 7,
      observedAt: "r",
      windows: {
        "7d": [
          { surface_id: "a", total: 100, ok_count: 95, avg_latency_ms: 50.4 },
        ],
        "30d": [
          { surface_id: "a", total: 400, ok_count: 380, avg_latency_ms: 60.9 },
        ],
      },
    });
    assert.equal(out.windows["7d"].uptime_ratio, 0.95);
    assert.equal(out.windows["7d"].surfaces[0].avg_latency_ms, 50);
    assert.equal(out.windows["30d"].uptime_ratio, 0.95);
    assert.equal(out.netuid, 7);
  });
  test("empty windows yield null ratios (D1 cold)", () => {
    const out = formatTrends({
      netuid: 7,
      observedAt: null,
      windows: { "7d": [], "30d": [] },
    });
    assert.equal(out.windows["7d"].uptime_ratio, null);
    assert.equal(out.windows["7d"].samples, 0);
  });
});

describe("subnetBadgeStatus", () => {
  test("finds the subnet rollup", () => {
    const live = { subnets: [{ netuid: 7, status: "degraded" }] };
    assert.equal(subnetBadgeStatus(live, 7).status, "degraded");
    assert.equal(subnetBadgeStatus(live, 9), null);
  });
});

// --- Worker integration: the LIVE path (mock KV + D1) -------------------------
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
function d1With(rows) {
  return {
    prepare() {
      return {
        bind() {
          return {
            async all() {
              return { results: rows };
            },
          };
        },
      };
    },
  };
}
const req = (path) => new Request(`https://api.metagraph.sh${path}`);

describe("worker live health serving", () => {
  test("/api/v1/health serves the live operational summary from KV", async () => {
    const env = createLocalArtifactEnv({
      METAGRAPH_CONTROL: kvWith({
        "health:current": {
          generated_at: "2026-06-11T00:00:00.000Z",
          last_run_at: "2026-06-11T00:00:00.000Z",
          summary: {
            surface_count: 58,
            status_counts: { ok: 57, degraded: 1 },
          },
          subnets: [{ netuid: 0, status: "ok" }],
        },
      }),
    });
    const res = await handleRequest(req("/api/v1/health"), env, {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.meta.source, "live-cron-prober");
    assert.equal(body.data.scope, "operational");
    assert.equal(body.meta.operational_observed_at, "2026-06-11T00:00:00.000Z");
  });

  test("/api/v1/subnets/0/health/trends queries D1", async () => {
    const env = createLocalArtifactEnv({
      METAGRAPH_HEALTH_DB: d1With([
        { surface_id: "rpc-a", total: 100, ok_count: 99, avg_latency_ms: 42 },
      ]),
      METAGRAPH_CONTROL: kvWith({
        "health:meta": { last_run_at: "2026-06-11T00:00:00.000Z" },
      }),
    });
    const res = await handleRequest(
      req("/api/v1/subnets/0/health/trends"),
      env,
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.netuid, 0);
    assert.equal(body.data.windows["7d"].uptime_ratio, 0.99);
    assert.equal(body.data.source, "live-cron-prober");
  });
});
