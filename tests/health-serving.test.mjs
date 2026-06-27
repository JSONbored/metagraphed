import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  OPERATIONAL_KINDS,
  buildGlobalHealth,
  formatBulkTrends,
  formatGlobalIncidents,
  formatTrends,
  mergeFreshness,
  mergeRpcEndpoints,
  overlayArtifactEndpoints,
  overlayCatalogDetail,
  overlayCatalogIndex,
  overlayOverviewHealth,
  overlayRpcPoolEligibility,
  overlaySubnetHealth,
  formatUptime,
  loadSubnetReliability,
  loadReliabilityAggregate,
  parseLive,
  resolveLiveHealth,
  subnetBadgeStatus,
  summarizeRows,
} from "../src/health-serving.mjs";
import { computeReliability, scoreFromStats } from "../src/reliability.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";
import { handleRequest } from "../workers/api.mjs";

// A recent prober run time for live KV fixtures that must pass resolveLiveHealth's
// freshness gate (KV health:current is rejected when last_run_at is older than the
// 25-min window). Worker-route tests go through handleRequest and cannot inject a
// clock, so the fixture must be fresh relative to Date.now().
const FRESH_RUN = new Date(Date.now() - 60_000).toISOString();

describe("overlaySubnetHealth", () => {
  test("builds per-subnet health from live rows without stale static surfaces", () => {
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
    assert.equal(api.status, "ok"); // overlaid live
    assert.equal(api.observed_by, "live-cron-prober");
    assert.equal(
      merged.surfaces.some((s) => s.surface_id === "sn7-docs"),
      false,
    );
    assert.equal(merged.summary.status, "ok"); // recomputed over live set
    assert.equal(merged.summary.ok_count, 1);
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
  test("overlays live status by id while preserving the artifact contract", () => {
    const stat = {
      schema_version: 1,
      generated_at: "old",
      summary: { total: 2 },
      endpoints: [
        { id: "a", status: "ok", health_source: "probe-derived" },
        { id: "b", status: "ok", health_source: "probe-derived" },
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
    const a = merged.endpoints.find((e) => e.id === "a");
    assert.equal(a.status, "failed");
    assert.equal(a.health_source, "probe-derived");
    assert.equal(a.pool_eligible, undefined);
    assert.deepEqual(merged.summary, { total: 2 });
    assert.equal(merged.generated_at, "g");
    assert.equal(merged.operational_observed_at, "r");
    assert.equal(merged.endpoints.find((e) => e.id === "b").status, "ok"); // no live → static
  });

  test("a failing endpoint's observed_at is the sweep time, not its stale last_ok", () => {
    const stat = {
      schema_version: 1,
      endpoints: [{ id: "a", status: "ok", health_source: "probe-derived" }],
    };
    const live = {
      last_run_at: "2026-06-11T00:00:00Z",
      endpoints: [
        {
          id: "a",
          status: "failed",
          classification: "dead",
          latency_ms: null,
          // last successful probe was hours ago; the endpoint is failing now.
          last_ok: "2026-06-10T08:00:00Z",
        },
      ],
    };
    const a = mergeRpcEndpoints(stat, live).endpoints.find((e) => e.id === "a");
    // health_stale:false claims a fresh observation, so observed_at must be the
    // run time — not the stale last-success timestamp.
    assert.equal(a.health_stale, false);
    assert.equal(a.observed_at, "2026-06-11T00:00:00Z");
  });

  test("observed_at falls back to last_ok, then null, when the run time is absent", () => {
    const stat = {
      schema_version: 1,
      endpoints: [
        { id: "a", status: "ok" },
        { id: "b", status: "ok" },
      ],
    };
    // No last_run_at on the pool → fall back to the endpoint's last_ok, then null.
    const live = {
      endpoints: [
        { id: "a", status: "ok", last_ok: "2026-06-10T08:00:00Z" },
        { id: "b", status: "failed" },
      ],
    };
    const merged = mergeRpcEndpoints(stat, live).endpoints;
    assert.equal(
      merged.find((e) => e.id === "a").observed_at,
      "2026-06-10T08:00:00Z",
    );
    assert.equal(merged.find((e) => e.id === "b").observed_at, null);
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
  test("drops endpoints only after sustained (>=2) consecutive failures", () => {
    const live = {
      endpoints: [
        { id: "a", status: "failed", consecutive_failures: 1 }, // transient blip → stays (hysteresis)
        { id: "b", status: "failed", consecutive_failures: 2 }, // sustained (~30 min at 15-min cadence) → drop
      ],
    };
    const out = overlayRpcPoolEligibility(pool, live);
    assert.equal(out.endpoints.find((e) => e.id === "a").pool_eligible, true);
    assert.equal(out.endpoints.find((e) => e.id === "b").pool_eligible, false);
  });
  test("immediately drops wrong-chain endpoints from the proxy pool", () => {
    const live = {
      endpoints: [
        {
          id: "a",
          status: "failed",
          classification: "wrong-chain",
          consecutive_failures: 1,
        },
      ],
    };
    const out = overlayRpcPoolEligibility(pool, live);
    assert.equal(out.endpoints.find((e) => e.id === "a").pool_eligible, false);
    assert.equal(out.endpoints.find((e) => e.id === "b").pool_eligible, true);
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
  test("clamps a sub-perfect uptime_ratio that would round up to 1", () => {
    const out = formatTrends({
      netuid: 7,
      observedAt: "r",
      windows: {
        "7d": [{ surface_id: "a", total: 25000, ok_count: 24999 }],
      },
    });
    assert.equal(out.windows["7d"].uptime_ratio, 0.9999);
    assert.equal(out.windows["7d"].surfaces[0].uptime_ratio, 0.9999);
    const perfect = formatTrends({
      netuid: 7,
      observedAt: "r",
      windows: {
        "7d": [{ surface_id: "a", total: 25000, ok_count: 25000 }],
      },
    });
    assert.equal(perfect.windows["7d"].uptime_ratio, 1);
  });
  test("empty windows yield null ratios (D1 cold)", () => {
    const out = formatTrends({
      netuid: 7,
      observedAt: null,
      windows: { "7d": [], "30d": [] },
    });
    assert.equal(out.windows["7d"].uptime_ratio, null);
    assert.equal(out.windows["7d"].samples, 0);
    assert.equal(out.windows["7d"].latency_sample_count, 0);
  });
  test("exposes p50/p95/p99 tail + healthy-sample count per surface", () => {
    const out = formatTrends({
      netuid: 7,
      observedAt: "r",
      windows: {
        "7d": [
          {
            surface_id: "a",
            total: 100,
            ok_count: 96,
            latency_samples: 96,
            avg_latency_ms: 50.4,
            p50: 40.6,
            p95: 410.2,
            p99: 900,
          },
        ],
      },
    });
    const surface = out.windows["7d"].surfaces[0];
    assert.equal(surface.avg_latency_ms, 50);
    assert.equal(surface.latency_sample_count, 96);
    assert.deepEqual(surface.latency_ms, { p50: 41, p95: 410, p99: 900 });
    // Window total rolls up the healthy-sample counts.
    assert.equal(out.windows["7d"].latency_sample_count, 96);
  });
});

describe("subnetBadgeStatus", () => {
  test("finds the subnet rollup", () => {
    const live = { subnets: [{ netuid: 7, status: "degraded" }] };
    assert.equal(subnetBadgeStatus(live, 7).status, "degraded");
    assert.equal(subnetBadgeStatus(live, 9), null);
  });
});

describe("parseLive", () => {
  test("null/undefined/empty → null", () => {
    assert.equal(parseLive(null), null);
    assert.equal(parseLive(undefined), null);
    assert.equal(parseLive(""), null);
  });
  test("already-an-object passes through unchanged", () => {
    const obj = { a: 1 };
    assert.equal(parseLive(obj), obj);
  });
  test("valid JSON string parses", () => {
    assert.deepEqual(parseLive('{"a":1}'), { a: 1 });
  });
  test("malformed JSON string → null", () => {
    assert.equal(parseLive("{not json"), null);
  });
});

describe("summarizeRows / rollupStatus", () => {
  const row = (status, extra = {}) => ({ status, ...extra });

  test("empty rows → unknown status, null aggregates", () => {
    const out = summarizeRows([]);
    assert.equal(out.status, "unknown");
    assert.equal(out.surface_count, 0);
    assert.equal(out.last_checked, null);
    assert.equal(out.last_ok, null);
    assert.equal(out.avg_latency_ms, null);
  });
  test("all-unknown → unknown", () => {
    assert.equal(
      summarizeRows([row("unknown"), row("unknown")]).status,
      "unknown",
    );
  });
  test("all-ok → ok", () => {
    assert.equal(summarizeRows([row("ok"), row("ok")]).status, "ok");
  });
  test("ok + failed mix → degraded", () => {
    assert.equal(summarizeRows([row("ok"), row("failed")]).status, "degraded");
  });
  test("ok + degraded mix → degraded", () => {
    assert.equal(
      summarizeRows([row("ok"), row("degraded")]).status,
      "degraded",
    );
  });
  test("degraded + failed (no ok) → degraded (right-hand OR operand)", () => {
    // ok=0 so the `(counts.ok||0)>0` left operand is false; degraded>0 carries it.
    assert.equal(
      summarizeRows([row("degraded"), row("failed")]).status,
      "degraded",
    );
  });
  test("all-failed (no ok, no degraded) → failed", () => {
    const out = summarizeRows([row("failed"), row("failed")]);
    assert.equal(out.status, "failed");
    assert.equal(out.failed_count, 2);
  });
  test("unrecognized status values roll up as unknown, not ok", () => {
    const out = summarizeRows([row("weird"), row("weird")]);
    assert.equal(out.status, "unknown");
    assert.equal(out.unknown_count, 2);
    assert.equal(out.ok_count, 0);
    assert.equal(out.failed_count, 0);
  });
  test("null or missing status is treated as unknown", () => {
    const out = summarizeRows([row(null), { status: undefined }]);
    assert.equal(out.status, "unknown");
    assert.equal(out.unknown_count, 2);
  });
  test("aggregates latency (rounded), latest last_checked/last_ok", () => {
    const out = summarizeRows([
      row("ok", {
        latency_ms: 10,
        last_checked: "2026-06-11T00:00:00.000Z",
        last_ok: "2026-06-11T00:00:00.000Z",
      }),
      row("ok", {
        latency_ms: 25,
        last_checked: "2026-06-11T00:05:00.000Z",
        last_ok: "2026-06-10T23:00:00.000Z",
      }),
      // Non-finite latency is skipped from the average.
      row("ok", { latency_ms: null, last_checked: null, last_ok: null }),
    ]);
    assert.equal(out.avg_latency_ms, 18); // round((10+25)/2)
    assert.equal(out.latency_sample_count, 2); // the null-latency row is excluded
    assert.equal(out.last_checked, "2026-06-11T00:05:00.000Z"); // latest
    assert.equal(out.last_ok, "2026-06-11T00:00:00.000Z"); // latest non-null
  });
});

describe("OPERATIONAL_KINDS export", () => {
  test("is a Set of the operational surface kinds", () => {
    assert.ok(OPERATIONAL_KINDS instanceof Set);
    assert.ok(OPERATIONAL_KINDS.has("subtensor-rpc"));
    assert.ok(OPERATIONAL_KINDS.has("data-artifact"));
    assert.equal(OPERATIONAL_KINDS.has("docs"), false);
  });
});

describe("overlaySubnetHealth (additional paths)", () => {
  test("null/empty live → null (no surfaces array)", () => {
    assert.equal(overlaySubnetHealth({ surfaces: [] }, null, 7), null);
    assert.equal(overlaySubnetHealth({ surfaces: [] }, {}, 7), null);
    assert.equal(
      overlaySubnetHealth({ surfaces: [] }, { surfaces: "nope" }, 7),
      null,
    );
  });

  test("no live rows for the netuid AND no static artifact → null", () => {
    const live = {
      surfaces: [{ surface_id: "x", netuid: 99, status: "ok" }],
    };
    assert.equal(overlaySubnetHealth(null, live, 7), null);
  });

  test("static null but live present → builds from live only", () => {
    const live = {
      last_run_at: "2026-06-11T00:00:00.000Z",
      surfaces: [
        {
          surface_id: "sn7-rpc",
          netuid: 7,
          kind: "subtensor-rpc",
          provider: "prov",
          url: "https://rpc",
          status: "ok",
          classification: "live",
          latency_ms: 30,
          status_code: 200,
          last_checked: "2026-06-11T00:00:00.000Z",
          last_ok: "2026-06-11T00:00:00.000Z",
        },
      ],
    };
    const out = overlaySubnetHealth(null, live, 7);
    assert.equal(out.netuid, 7);
    assert.equal(out.schema_version, 1); // default when no static
    assert.equal(out.surfaces.length, 1);
    const pushed = out.surfaces[0];
    assert.equal(pushed.surface_id, "sn7-rpc");
    assert.equal(pushed.kind, "subtensor-rpc");
    assert.equal(pushed.provider, "prov");
    assert.equal(pushed.url, "https://rpc");
    assert.equal(pushed.status_code, 200);
    assert.equal(pushed.observed_by, "live-cron-prober");
    assert.equal(out.summary.status, "ok");
  });

  test("static artifact without a surfaces array → treated as empty, live pushed", () => {
    const live = {
      last_run_at: null,
      surfaces: [
        {
          surface_id: "sn7-rpc",
          netuid: 7,
          kind: "subtensor-rpc",
          status: "ok",
        },
      ],
    };
    const out = overlaySubnetHealth({ schema_version: 2 }, live, 7);
    assert.equal(out.schema_version, 2);
    assert.equal(out.surfaces.length, 1);
    assert.equal(out.surfaces[0].observed_by, "live-cron-prober");
    assert.equal(out.operational_observed_at, null); // last_run_at falsy → null
  });

  test("live surfaces NOT in static get pushed as new operational surfaces", () => {
    const staticArtifact = {
      schema_version: 1,
      contract_version: "cv",
      generated_at: "ga",
      slug: "acme",
      name: "Acme",
      surfaces: [
        { surface_id: "sn7-api", kind: "subnet-api", status: "failed" },
      ],
    };
    const live = {
      last_run_at: "2026-06-11T00:00:00.000Z",
      surfaces: [
        // Matches an existing static surface (replace branch).
        {
          surface_id: "sn7-api",
          netuid: 7,
          kind: "subnet-api",
          status: "ok",
          latency_ms: 10,
        },
        // Brand new operational surface (push branch).
        {
          surface_id: "sn7-new",
          netuid: 7,
          kind: "sse",
          provider: "p2",
          url: "https://sse",
          status: "ok",
          classification: "live",
          latency_ms: 20,
          status_code: 200,
          last_checked: "2026-06-11T00:00:00.000Z",
          last_ok: "2026-06-11T00:00:00.000Z",
        },
        // Different netuid → ignored entirely.
        { surface_id: "other", netuid: 99, kind: "sse", status: "failed" },
      ],
    };
    const out = overlaySubnetHealth(staticArtifact, live, 7);
    assert.equal(out.contract_version, "cv");
    assert.equal(out.generated_at, "ga");
    assert.equal(out.slug, "acme");
    assert.equal(out.name, "Acme");
    const ids = out.surfaces.map((s) => s.surface_id).sort();
    assert.deepEqual(ids, ["sn7-api", "sn7-new"]);
    const pushed = out.surfaces.find((s) => s.surface_id === "sn7-new");
    assert.equal(pushed.observed_by, "live-cron-prober");
    assert.equal(pushed.netuid, 7);
    assert.equal(out.summary.status, "ok");
    assert.equal(out.summary.ok_count, 2);
  });
});

describe("buildGlobalHealth (additional paths)", () => {
  test("null live → null", () => {
    assert.equal(buildGlobalHealth(null, {}), null);
  });
  test("live without a summary → null", () => {
    assert.equal(buildGlobalHealth({ generated_at: "g" }, {}), null);
  });
  test("defaults subnets to [] and falls back last_run_at to null", () => {
    const out = buildGlobalHealth(
      { generated_at: "g", summary: { status: "ok" } },
      null,
    );
    assert.deepEqual(out.subnets, []);
    assert.equal(out.operational_observed_at, null);
    assert.equal(out.contract_version, undefined);
  });
});

describe("subnetBadgeStatus (additional paths)", () => {
  test("null live → null", () => {
    assert.equal(subnetBadgeStatus(null, 7), null);
  });
  test("live without subnets array → null", () => {
    assert.equal(subnetBadgeStatus({ subnets: "nope" }, 7), null);
  });
});

describe("mergeRpcEndpoints (additional paths)", () => {
  test("null live or live without endpoints array → null", () => {
    assert.equal(mergeRpcEndpoints({ endpoints: [] }, null), null);
    assert.equal(mergeRpcEndpoints({ endpoints: [] }, {}), null);
    assert.equal(
      mergeRpcEndpoints({ endpoints: [] }, { endpoints: "nope" }),
      null,
    );
  });

  test("archive_support falls back to the static value when live omits it", () => {
    const stat = {
      schema_version: 3,
      contract_version: "cv",
      generated_at: "old",
      summary: { total: 1 },
      endpoints: [{ id: "a", status: "ok", archive_support: true }],
    };
    const live = {
      last_run_at: "r",
      generated_at: "g",
      endpoints: [
        // archive_support undefined → keep static true; last_ok null → use last_run_at.
        {
          id: "a",
          status: "ok",
          classification: "live",
          latency_ms: 5,
          last_ok: null,
          pool_eligible: true,
        },
      ],
    };
    const out = mergeRpcEndpoints(stat, live);
    assert.equal(out.schema_version, 3);
    assert.equal(out.contract_version, "cv");
    const a = out.endpoints.find((e) => e.id === "a");
    assert.equal(a.archive_support, true); // fallback to static
    assert.equal(a.health_source, "probe-derived");
    assert.equal(a.health_stale, false);
    assert.equal(a.pool_eligible, undefined);
    assert.deepEqual(out.summary, { total: 1 });
    assert.equal(a.observed_at, "r"); // last_ok null → last_run_at
  });

  test("static WITHOUT an endpoints array → null so caller serves static", () => {
    const live = {
      last_run_at: "r",
      generated_at: "g",
      endpoints: [{ id: "x", status: "ok" }],
    };
    assert.equal(mergeRpcEndpoints({ schema_version: 1 }, live), null);
  });

  test("static null entirely → null so caller serves static", () => {
    const live = {
      last_run_at: null,
      generated_at: "g",
      endpoints: [{ id: "x", status: "ok" }],
    };
    assert.equal(mergeRpcEndpoints(null, live), null);
  });
});

describe("overlayRpcPoolEligibility (additional paths)", () => {
  test("null pool → returned unchanged (null)", () => {
    assert.equal(overlayRpcPoolEligibility(null, { endpoints: [] }), null);
  });
  test("live without endpoints array → pool unchanged", () => {
    const pool = { endpoints: [{ id: "a", pool_eligible: true }] };
    assert.equal(overlayRpcPoolEligibility(pool, { endpoints: "nope" }), pool);
    assert.equal(overlayRpcPoolEligibility(pool, {}), pool);
  });

  test("endpoint with no live match stays unchanged; latency fallback used", () => {
    const pool = {
      endpoints: [
        { id: "a", pool_eligible: true, latency_ms: 11 },
        { id: "no-live", pool_eligible: true, latency_ms: 99 },
      ],
    };
    const live = {
      endpoints: [
        // status ok → not sustained-down even if a stray failure count exists;
        // latency_ms missing → fall back to endpoint.latency_ms.
        { id: "a", status: "ok", consecutive_failures: 5 },
      ],
    };
    const out = overlayRpcPoolEligibility(pool, live);
    const a = out.endpoints.find((e) => e.id === "a");
    assert.equal(a.pool_eligible, true); // status ok ⇒ not sustainedDown
    assert.equal(a.latency_ms, 11); // fallback to endpoint.latency_ms
    assert.equal(a.health_source, "live-cron-prober");
    const noLive = out.endpoints.find((e) => e.id === "no-live");
    assert.equal(noLive.latency_ms, 99);
    assert.equal(noLive.health_source, undefined); // untouched
  });

  test("pool without an endpoints array → maps over [] (no throw)", () => {
    const out = overlayRpcPoolEligibility({ id: "p" }, { endpoints: [] });
    assert.deepEqual(out.endpoints, []);
    assert.equal(out.id, "p");
  });

  test("sustained-down endpoint with explicit live latency drops eligibility", () => {
    const pool = {
      endpoints: [{ id: "a", pool_eligible: true, latency_ms: 5 }],
    };
    const live = {
      endpoints: [
        { id: "a", status: "failed", consecutive_failures: 4, latency_ms: 70 },
      ],
    };
    const out = overlayRpcPoolEligibility(pool, live);
    const a = out.endpoints.find((e) => e.id === "a");
    assert.equal(a.pool_eligible, false);
    assert.equal(a.latency_ms, 70); // explicit live latency wins
  });
});

describe("mergeFreshness (additional paths)", () => {
  test("null live meta or null static → null", () => {
    assert.equal(mergeFreshness({ sources: [] }, null), null);
    assert.equal(mergeFreshness(null, { last_run_at: "r" }), null);
  });

  test("sources NOT an array → passed through verbatim", () => {
    const stat = { sources: "nope", summary: { a: 1 } };
    const out = mergeFreshness(stat, { last_run_at: "r" });
    assert.equal(out.sources, "nope");
    assert.equal(out.summary.health_probe_as_of, "r");
    assert.equal(out.summary.operational_probe_as_of, "r");
    assert.equal(out.summary.a, 1); // preserves existing summary keys
  });
});

describe("formatTrends (additional paths)", () => {
  test("surfaces are sorted by surface_id; null avg_latency passes through", () => {
    const out = formatTrends({
      netuid: 7,
      observedAt: "r",
      windows: {
        "7d": [
          { surface_id: "z", total: 10, ok_count: 5, avg_latency_ms: null },
          { surface_id: "a", total: 4, ok_count: 1, avg_latency_ms: 12.6 },
          // total 0 → uptime_ratio null for that surface.
          { surface_id: "m", total: 0, ok_count: 0, avg_latency_ms: 9 },
        ],
      },
    });
    const w = out.windows["7d"];
    assert.deepEqual(
      w.surfaces.map((s) => s.surface_id),
      ["a", "m", "z"],
    );
    assert.equal(
      w.surfaces.find((s) => s.surface_id === "z").avg_latency_ms,
      null,
    );
    assert.equal(
      w.surfaces.find((s) => s.surface_id === "a").avg_latency_ms,
      13,
    );
    assert.equal(
      w.surfaces.find((s) => s.surface_id === "m").uptime_ratio,
      null,
    );
    assert.equal(w.samples, 14);
    assert.equal(w.uptime_ratio, Number((6 / 14).toFixed(4)));
  });

  test("observedAt omitted → null", () => {
    const out = formatTrends({ netuid: 1, windows: { "7d": [] } });
    assert.equal(out.observed_at, null);
  });
});

describe("formatBulkTrends", () => {
  test("groups daily rows by subnet and sorts subnets/points", () => {
    const out = formatBulkTrends({
      observedAt: "2026-06-11T00:00:00.000Z",
      windowDays: { "7d": 7, "30d": 30 },
      windows: {
        "7d": [
          {
            netuid: 8,
            date: "2026-06-10",
            total: 4,
            ok_count: 2,
            avg_latency_ms: 10.2,
          },
          {
            netuid: 7,
            date: "2026-06-11",
            total: 10,
            ok_count: 9,
            avg_latency_ms: 50.4,
          },
          {
            netuid: 7,
            date: "2026-06-10",
            total: 5,
            ok_count: 5,
            avg_latency_ms: 30,
          },
        ],
        "30d": [],
      },
    });

    assert.equal(out.schema_version, 1);
    assert.equal(out.source, "live-cron-prober");
    assert.equal(out.windows["7d"].days, 7);
    assert.equal(out.windows["7d"].granularity, "1d");
    assert.equal(out.windows["7d"].subnet_count, 2);
    assert.deepEqual(
      out.windows["7d"].subnets.map((entry) => entry.netuid),
      [7, 8],
    );

    const sn7 = out.windows["7d"].subnets[0];
    assert.equal(sn7.samples, 15);
    assert.equal(sn7.uptime_ratio, Number((14 / 15).toFixed(4)));
    assert.equal(sn7.avg_latency_ms, 44);
    assert.deepEqual(
      sn7.points.map((point) => point.date),
      ["2026-06-10", "2026-06-11"],
    );
    assert.equal(sn7.points[1].uptime_ratio, 0.9);
    assert.equal(sn7.points[1].avg_latency_ms, 50);
    assert.equal(out.windows["30d"].subnet_count, 0);
  });

  test("weights the mean by latency_samples (not total) and reports the count", () => {
    const out = formatBulkTrends({
      windowDays: { "7d": 7 },
      windows: {
        "7d": [
          // 100ms backed by 10 healthy readings, 200ms by 90 — failure-heavy day
          // one must NOT drag the mean toward 100 by its larger total.
          {
            netuid: 7,
            date: "2026-06-10",
            total: 100,
            ok_count: 10,
            avg_latency_ms: 100,
            latency_samples: 10,
          },
          {
            netuid: 7,
            date: "2026-06-11",
            total: 90,
            ok_count: 90,
            avg_latency_ms: 200,
            latency_samples: 90,
          },
        ],
      },
    });
    const sn7 = out.windows["7d"].subnets[0];
    // (100*10 + 200*90) / 100 = 190, weighted by healthy readings.
    assert.equal(sn7.avg_latency_ms, 190);
    assert.equal(sn7.latency_sample_count, 100);
    assert.equal(sn7.points[0].latency_sample_count, 10);
    assert.equal(sn7.points[1].latency_sample_count, 90);
  });

  test("empty or invalid rows keep the schema-stable cold shape", () => {
    const out = formatBulkTrends({
      windows: {
        "7d": [
          { netuid: -1, date: "2026-06-10", total: 1, ok_count: 1 },
          { netuid: 7, date: "not-a-date", total: 1, ok_count: 1 },
        ],
      },
      windowDays: { "7d": 7 },
    });
    assert.equal(out.observed_at, null);
    assert.equal(out.windows["7d"].days, 7);
    assert.equal(out.windows["7d"].subnet_count, 0);
    assert.deepEqual(out.windows["7d"].subnets, []);
  });

  test("covers zero-sample and omitted-window fallback branches", () => {
    const empty = formatBulkTrends({});
    assert.deepEqual(empty.windows, {});

    const out = formatBulkTrends({
      windows: {
        "7d": null,
        cold: [
          {
            netuid: 7,
            date: "2026-06-10",
            total: 0,
            ok_count: undefined,
            avg_latency_ms: null,
          },
          {
            netuid: 7,
            date: "2026-06-11",
            total: undefined,
            ok_count: undefined,
            avg_latency_ms: "not-a-number",
          },
          { netuid: "bad", date: "2026-06-10", total: 1, ok_count: 1 },
          { netuid: 9, total: 1, ok_count: 1 },
        ],
      },
    });

    assert.equal(out.windows["7d"].days, 0);
    assert.equal(out.windows["7d"].subnet_count, 0);
    const sn7 = out.windows.cold.subnets[0];
    assert.equal(sn7.samples, 0);
    assert.equal(sn7.uptime_ratio, null);
    assert.equal(sn7.avg_latency_ms, null);
    assert.equal(sn7.points[0].uptime_ratio, null);
    assert.equal(sn7.points[0].avg_latency_ms, null);
    assert.equal(sn7.points[1].avg_latency_ms, null);
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

// Minimal R2 archive binding that serves a single static rpc/pools.json fixture
// (the artifact is R2-only, so there is nothing on disk for createLocalArtifactEnv
// to read). Keyed on `latest/rpc/pools.json`, mirroring latestR2Key().
function rpcPoolsArchiveFixture(artifact) {
  return {
    async get(key) {
      if (String(key).replace(/^latest\//, "") !== "rpc/pools.json")
        return null;
      return {
        async json() {
          return artifact;
        },
      };
    },
  };
}

describe("worker live health serving", () => {
  test("/api/v1/health serves the live operational summary from KV", async () => {
    const env = createLocalArtifactEnv({
      METAGRAPH_CONTROL: kvWith({
        "health:current": {
          generated_at: "2026-06-11T00:00:00.000Z",
          last_run_at: FRESH_RUN,
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
    assert.equal(body.meta.operational_observed_at, FRESH_RUN);
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

  test("/api/v1/health/trends rejects unsupported query parameters before D1", async () => {
    let queried = false;
    const env = createLocalArtifactEnv({
      METAGRAPH_HEALTH_DB: {
        prepare() {
          queried = true;
          return d1With([]).prepare();
        },
      },
    });
    const res = await handleRequest(
      req("/api/v1/health/trends?cacheBust=1"),
      env,
      {},
    );
    assert.equal(res.status, 400);
    assert.equal(queried, false);
    const body = await res.json();
    assert.equal(body.error.code, "invalid_query");
    assert.equal(body.meta.parameter, "cacheBust");
  });

  test("/api/v1/health/trends reads the bounded daily rollup once", async () => {
    const queries = [];
    const env = createLocalArtifactEnv({
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          queries.push(sql);
          return {
            bind(...params) {
              queries.push(params);
              return {
                async all() {
                  return { results: [] };
                },
              };
            },
          };
        },
      },
    });
    const res = await handleRequest(req("/api/v1/health/trends"), env, {});
    assert.equal(res.status, 200);
    assert.equal(
      queries.filter((entry) => typeof entry === "string").length,
      1,
    );
    assert.match(queries[0], /FROM surface_uptime_daily/);
    assert.doesNotMatch(queries[0], /FROM surface_checks/);
    assert.match(queries[0], /LIMIT \?/);
    assert.equal(queries[1][1], 10000);
  });

  test("/api/v1/health/trends queries compact all-subnet D1 rows", async () => {
    // Date the rows relative to "now" so they always fall inside the live 7d
    // window the handler derives from Date.now() (`day >= now − 7d`). A fixed
    // calendar date ages out of the window and turns this into a time-bomb that
    // fails repo-wide the day the clock passes it.
    const recentDay = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const env = createLocalArtifactEnv({
      METAGRAPH_HEALTH_DB: d1With([
        {
          netuid: 8,
          date: recentDay,
          total: 10,
          ok_count: 8,
          avg_latency_ms: 30,
        },
        {
          netuid: 7,
          date: recentDay,
          total: 5,
          ok_count: 5,
          avg_latency_ms: 20,
        },
      ]),
      METAGRAPH_CONTROL: kvWith({
        "health:meta": { last_run_at: "2026-06-11T00:00:00.000Z" },
      }),
    });
    const res = await handleRequest(req("/api/v1/health/trends"), env, {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.meta.artifact_path, "/metagraph/health/trends.json");
    assert.equal(body.data.observed_at, "2026-06-11T00:00:00.000Z");
    assert.equal(body.data.windows["7d"].days, 7);
    assert.deepEqual(
      body.data.windows["7d"].subnets.map((entry) => entry.netuid),
      [7, 8],
    );
    assert.equal(
      body.data.windows["7d"].subnets[1].points[0].uptime_ratio,
      0.8,
    );
  });

  test("/api/v1/rpc/pools overlays live KV health so a dead upstream is marked ineligible", async () => {
    // The static R2 artifact still lists `dead` as pool_eligible (it was healthy
    // at build time). The wss-lb / proxy route off this served body, so without
    // the overlay they would keep routing to a node that has been down for ~30 min.
    const env = createLocalArtifactEnv({
      METAGRAPH_ARCHIVE: rpcPoolsArchiveFixture({
        schema_version: 1,
        generated_at: "1970-01-01T00:00:00.000Z",
        source: "rpc-endpoint-probes",
        pools: [
          {
            id: "finney-rpc",
            kind: "subtensor-rpc",
            endpoints: [
              { id: "live", pool_eligible: true, status: "ok" },
              { id: "dead", pool_eligible: true, status: "ok" },
            ],
          },
        ],
      }),
      METAGRAPH_CONTROL: kvWith({
        "health:rpc-pool": {
          schema_version: 1,
          last_run_at: FRESH_RUN,
          endpoints: [
            { id: "live", status: "ok", consecutive_failures: 0 },
            // Sustained-down (≥2 consecutive failed prober runs) → drop from pool.
            { id: "dead", status: "failed", consecutive_failures: 3 },
          ],
        },
      }),
    });
    const res = await handleRequest(req("/api/v1/rpc/pools"), env, {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.meta.source, "live-cron-prober");
    assert.equal(body.meta.operational_observed_at, FRESH_RUN);
    const endpoints = body.data.pools[0].endpoints;
    const live = endpoints.find((e) => e.id === "live");
    const dead = endpoints.find((e) => e.id === "dead");
    assert.equal(live.pool_eligible, true);
    assert.equal(dead.pool_eligible, false);
    assert.equal(dead.status, "failed");
    assert.equal(dead.health_source, "live-cron-prober");
  });

  test("/api/v1/rpc/pools serves the static artifact when the live KV snapshot is cold", async () => {
    const env = createLocalArtifactEnv({
      METAGRAPH_ARCHIVE: rpcPoolsArchiveFixture({
        schema_version: 1,
        generated_at: "1970-01-01T00:00:00.000Z",
        source: "rpc-endpoint-probes",
        pools: [
          {
            id: "finney-rpc",
            endpoints: [{ id: "dead", pool_eligible: true, status: "ok" }],
          },
        ],
      }),
      // No health:rpc-pool entry → cold live snapshot → static passthrough.
      METAGRAPH_CONTROL: kvWith({}),
    });
    const res = await handleRequest(req("/api/v1/rpc/pools"), env, {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.pools[0].endpoints[0].pool_eligible, true);
  });
});

describe("resolveLiveHealth (KV → D1 → null)", () => {
  const liveKv = {
    last_run_at: FRESH_RUN,
    surfaces: [
      {
        surface_id: "7:subnet-api:x",
        surface_key: "srf-livekv00000000",
        netuid: 7,
        status: "ok",
      },
    ],
    subnets: [{ netuid: 7, status: "ok" }],
  };

  test("prefers KV health:current and labels the source", async () => {
    const live = await resolveLiveHealth({
      readHealthKv: async (_e, key) =>
        key === "health:current" ? liveKv : null,
      env: {},
    });
    assert.equal(live.health_source, "live-cron-prober");
    assert.equal(live.surfaces[0].status, "ok");
  });

  test("rejects a stale KV health:current (wedged prober) and falls through", async () => {
    // KV has no TTL, so a wedged prober's last snapshot must not serve forever.
    const stale = { ...liveKv, last_run_at: "2020-01-01T00:00:00.000Z" };
    const live = await resolveLiveHealth({
      readHealthKv: async (_e, key) =>
        key === "health:current" ? stale : null,
      env: {}, // no db → stale KV rejected → null (caller serves `unknown`)
    });
    assert.equal(live, null);
  });

  test("falls back to fresh D1 surface_status rows when KV is cold", async () => {
    const observedCutoffs = [];
    const now = 1_700_000_600_000;
    const db = {
      prepare: (sql) => {
        assert.match(sql, /WHERE last_checked >= \?/);
        assert.match(sql, /surface_key/);
        return {
          bind: (cutoff) => {
            observedCutoffs.push(cutoff);
            return {
              all: async () => ({
                results: [
                  {
                    surface_id: "7:subnet-api:x",
                    surface_key: "srf-d1fallback0000",
                    netuid: 7,
                    kind: "subnet-api",
                    provider: "x",
                    url: "https://x",
                    status: "failed",
                    classification: "down",
                    latency_ms: null,
                    status_code: 503,
                    last_checked: 1_700_000_000_000,
                    last_ok: 1_699_000_000_000,
                  },
                ],
              }),
            };
          },
        };
      },
    };
    const live = await resolveLiveHealth({
      readHealthKv: async () => null,
      env: {},
      db,
      now: () => now,
    });
    assert.equal(live.health_source, "live-d1-fallback");
    assert.equal(live.surfaces[0].status, "failed");
    assert.equal(live.surfaces[0].surface_key, "srf-d1fallback0000");
    assert.equal(live.subnets[0].netuid, 7);
    assert.equal(live.subnets[0].status, "failed");
    // cutoff = now (1_700_000_600_000) − D1_HEALTH_FALLBACK_MAX_AGE_MS (25 min).
    assert.deepEqual(observedCutoffs, [1_699_999_100_000]);
    // ms → ISO conversion for D1 timestamps.
    assert.match(live.surfaces[0].last_checked, /^20\d\d-/);
  });

  test("D1 fallback folds unrecognized surface status into unknown in global status_counts", async () => {
    const now = 1_700_000_600_000;
    const db = {
      prepare: () => ({
        bind: () => ({
          all: async () => ({
            results: [
              {
                surface_id: "7:subnet-api:x",
                surface_key: "srf-d1fallback0000",
                netuid: 7,
                kind: "subnet-api",
                provider: "x",
                url: "https://x",
                status: "throttled",
                classification: "rate-limited",
                latency_ms: null,
                status_code: 429,
                last_checked: 1_700_000_000_000,
                last_ok: null,
              },
            ],
          }),
        }),
      }),
    };
    const live = await resolveLiveHealth({
      readHealthKv: async () => null,
      env: {},
      db,
      now: () => now,
    });
    assert.equal(live.summary.status_counts.unknown, 1);
    assert.equal(live.summary.status_counts.throttled, undefined);
    assert.equal(live.summary.surface_count, 1);
  });

  test("does not return stale D1-only surface_status rows", async () => {
    const db = {
      prepare: () => ({
        bind: (cutoff) => ({
          all: async () => ({
            results: [
              {
                surface_id: "7:subnet-api:current",
                netuid: 7,
                kind: "subnet-api",
                provider: "current",
                url: "https://current.example/api",
                status: "ok",
                classification: "live",
                latency_ms: 10,
                status_code: 200,
                last_checked: cutoff,
                last_ok: cutoff,
              },
            ],
          }),
        }),
      }),
    };
    const live = await resolveLiveHealth({
      readHealthKv: async () => null,
      env: {},
      db,
      now: () => 1_700_000_600_000,
    });
    assert.deepEqual(
      live.surfaces.map((surface) => surface.surface_id),
      ["7:subnet-api:current"],
    );
  });

  test("returns null when neither KV nor D1 has data", async () => {
    assert.equal(
      await resolveLiveHealth({ readHealthKv: async () => null, env: {} }),
      null,
    );
  });

  test("KV throwing or returning a non-snapshot falls through to D1/null", async () => {
    // KV read throws → D1 (cold) → null.
    assert.equal(
      await resolveLiveHealth({
        readHealthKv: async () => {
          throw new Error("kv down");
        },
        env: {},
      }),
      null,
    );
    // KV returns an object without a surfaces array → falls through to null.
    assert.equal(
      await resolveLiveHealth({
        readHealthKv: async () => ({ not: "a snapshot" }),
        env: {},
      }),
      null,
    );
  });

  test("D1 query throwing degrades to null (never a baked value)", async () => {
    const db = {
      prepare: () => ({
        all: async () => {
          throw new Error("d1 down");
        },
      }),
    };
    assert.equal(
      await resolveLiveHealth({ readHealthKv: async () => null, env: {}, db }),
      null,
    );
  });
});

describe("composed-artifact health overlays", () => {
  const live = {
    last_run_at: "2026-06-13T00:00:00.000Z",
    health_source: "live-cron-prober",
    subnets: [{ netuid: 7, status: "failed", surface_count: 1, ok_count: 0 }],
    surfaces: [
      {
        surface_id: "7:subnet-api:renamed",
        surface_key: "srf-subnetapix0000",
        netuid: 7,
        status: "failed",
        classification: "down",
        latency_ms: null,
        last_ok: "2026-06-12T00:00:00.000Z",
        last_checked: "2026-06-13T00:00:00.000Z",
      },
    ],
  };

  test("overlayOverviewHealth replaces baked health with live (or unknown)", () => {
    const overview = { netuid: 7, health: { netuid: 7, status: "ok" } };
    const out = overlayOverviewHealth(overview, live, 7);
    assert.equal(out.health.status, "failed");
    assert.equal(out.health.observed_by, "live-cron-prober");
    assert.equal(out.operational_observed_at, live.last_run_at);
    assert.equal(out.health_source, "live-cron-prober");
    // subnet with no live rows → unknown, never the baked value.
    const unknown = overlayOverviewHealth(
      { netuid: 9, health: { status: "ok" } },
      live,
      9,
    );
    assert.equal(unknown.health.status, "unknown");
    // no live snapshot → null (caller falls back).
    assert.equal(overlayOverviewHealth(overview, null, 7), null);
  });

  test("overlayCatalogDetail makes per-service health + callable live", () => {
    const detail = {
      netuid: 7,
      services: [
        {
          surface_id: "7:subnet-api:x",
          surface_key: "srf-subnetapix0000",
          base_url: "https://x",
          health: { status: "ok", stale: true },
          eligibility: { callable: true, reasons: [] },
        },
      ],
    };
    const out = overlayCatalogDetail(detail, live, 7);
    assert.equal(out.services[0].health.status, "failed");
    assert.equal(out.services[0].health.stale, false);
    // live status failed → not callable now, even though baked said callable.
    assert.equal(out.services[0].eligibility.callable, false);
    assert.equal(out.services[0].base_url, "https://x"); // structural kept
    assert.equal(out.health_source, "live-cron-prober");
    assert.equal(overlayCatalogDetail(detail, null, 7), null);
  });

  test("overlayCatalogDetail joins renamed services by stable surface_key", () => {
    const detail = {
      netuid: 7,
      services: [
        {
          surface_id: "7:subnet-api:old-name",
          surface_key: "srf-subnetapix0000",
          base_url: "https://x",
          health: { status: "ok", stale: true },
          eligibility: { callable: true },
        },
      ],
    };
    const out = overlayCatalogDetail(detail, live, 7);
    assert.equal(out.services[0].surface_id, "7:subnet-api:old-name");
    assert.equal(out.services[0].health.status, "failed");
    assert.equal(out.services[0].eligibility.callable, false);
  });

  test("overlayCatalogDetail marks a service with no live row as unknown", () => {
    const detail = {
      netuid: 7,
      services: [
        {
          surface_id: "7:subnet-api:other",
          base_url: "https://other",
          health: { status: "ok", classification: "live", stale: true },
          eligibility: { callable: true },
        },
      ],
    };
    const out = overlayCatalogDetail(detail, live, 7);
    assert.equal(out.services[0].health.status, "unknown");
    assert.equal(out.services[0].health.observed_by, "unavailable");
    // classification falls back to the static value when no live row exists.
    assert.equal(out.services[0].health.classification, "live");
    assert.equal(out.services[0].eligibility.callable, false);
  });

  test("overlayCatalogDetail gates readiness_verified on a live ok probe (#357)", () => {
    const readiness = {
      score: 100,
      readiness_tier: "buildable",
      readiness_version: 2,
      components: { has_callable_api: true },
    };
    const detail = {
      netuid: 7,
      readiness,
      services: [
        {
          surface_id: "7:subnet-api:x",
          surface_key: "srf-subnetapix0000",
          base_url: "https://x",
          health: { status: "ok", stale: true },
          eligibility: { callable: true },
        },
      ],
    };
    // live `x` probed "failed" → catalogued but NOT verified; score untouched.
    const dead = overlayCatalogDetail(detail, live, 7);
    assert.equal(dead.readiness.readiness_verified, false);
    assert.equal(dead.readiness.score, 100);
    assert.equal(dead.readiness.readiness_tier, "buildable");
    // same surface probed "ok" → verified.
    const okLive = {
      ...live,
      surfaces: [{ ...live.surfaces[0], status: "ok" }],
    };
    const verified = overlayCatalogDetail(detail, okLive, 7);
    assert.equal(verified.readiness.readiness_verified, true);
    // a detail with no readiness object → field simply absent (no crash).
    const bare = overlayCatalogDetail(
      { netuid: 7, services: detail.services },
      okLive,
      7,
    );
    assert.equal(bare.readiness, undefined);
  });

  test("overlayCatalogIndex returns null without a live snapshot", () => {
    assert.equal(overlayCatalogIndex({ subnets: [] }, null), null);
  });

  test("overlayCatalogIndex overlays per-subnet status", () => {
    const index = { subnets: [{ netuid: 7, health: "ok", callable_count: 2 }] };
    const out = overlayCatalogIndex(index, live);
    assert.equal(out.subnets[0].health, "failed");
    assert.equal(out.subnets[0].callable_count, 2); // structural count untouched
    assert.equal(out.operational_observed_at, live.last_run_at);
  });

  test("overlayArtifactEndpoints replaces baked per-endpoint health with live", () => {
    const artifact = {
      netuid: 7,
      summary: { by_status: { ok: 2 }, pool_eligible_count: 2 },
      endpoints: [
        {
          surface_id: "7:subnet-api:x",
          surface_key: "srf-subnetapix0000",
          url: "https://x",
          status: "ok",
          classification: "live",
          health_source: "probe-derived",
          health_stale: false,
          observed_at: "BUILD",
          last_ok: "BUILD",
          latency_ms: 999,
          pool_eligible: true,
          error: null,
        },
        {
          surface_id: "7:docs:absent",
          url: "https://absent",
          status: "ok",
          health_source: "probe-derived",
          health_stale: false,
          observed_at: "BUILD",
          pool_eligible: true,
        },
      ],
    };
    const out = overlayArtifactEndpoints(artifact, live);
    // surface present in the live snapshot → live values, never the baked ones.
    const a = out.endpoints[0];
    assert.equal(a.status, "failed");
    assert.equal(a.health_source, "live-cron-prober");
    assert.equal(a.health_stale, false);
    assert.equal(a.observed_at, live.last_run_at ? a.observed_at : null);
    assert.equal(a.last_checked, "2026-06-13T00:00:00.000Z");
    assert.equal(a.pool_eligible, false); // live status failed → not eligible
    assert.equal(a.url, "https://x"); // structural kept
    // surface absent from the live snapshot → unknown, never the baked value.
    const b = out.endpoints[1];
    assert.equal(b.status, "unknown");
    assert.equal(b.health_source, "unavailable");
    assert.equal(b.health_stale, true);
    assert.equal(b.pool_eligible, false);
    assert.equal(b.url, "https://absent"); // structural kept
    // freshness + recomputed histogram surface at the top level.
    assert.equal(out.operational_observed_at, live.last_run_at);
    assert.equal(out.health_source, "live-cron-prober");
    assert.deepEqual(out.summary.by_status, { failed: 1, unknown: 1 });
    assert.equal(out.summary.pool_eligible_count, 0);
  });

  test("overlayArtifactEndpoints folds unrecognized live status into unknown in by_status", () => {
    const live = {
      last_run_at: "2026-06-13T00:00:00.000Z",
      health_source: "live-cron-prober",
      surfaces: [
        {
          surface_id: "7:subnet-api:x",
          surface_key: "srf-subnetapix0000",
          netuid: 7,
          status: "throttled",
          classification: "rate-limited",
          latency_ms: 120,
          last_checked: "2026-06-13T00:00:00.000Z",
          last_ok: "2026-06-13T00:00:00.000Z",
        },
      ],
    };
    const artifact = {
      summary: { by_status: { ok: 1 }, pool_eligible_count: 1 },
      endpoints: [
        {
          surface_id: "7:subnet-api:x",
          surface_key: "srf-subnetapix0000",
          url: "https://x",
          status: "ok",
          health_source: "probe-derived",
          health_stale: false,
          observed_at: "BUILD",
          pool_eligible: true,
        },
      ],
    };
    const out = overlayArtifactEndpoints(artifact, live);
    assert.equal(out.endpoints[0].status, "unknown");
    assert.deepEqual(out.summary.by_status, { unknown: 1 });
    assert.equal(out.summary.by_status.throttled, undefined);
    assert.equal(out.summary.pool_eligible_count, 0);
  });

  test("overlayArtifactEndpoints joins renamed endpoints by stable surface_key", () => {
    const out = overlayArtifactEndpoints(
      {
        endpoints: [
          {
            surface_id: "7:subnet-api:old-name",
            surface_key: "srf-subnetapix0000",
            status: "ok",
            health_source: "probe-derived",
            health_stale: false,
          },
        ],
      },
      live,
    );
    assert.equal(out.endpoints[0].surface_id, "7:subnet-api:old-name");
    assert.equal(out.endpoints[0].status, "failed");
    assert.equal(out.endpoints[0].health_source, "live-cron-prober");
  });

  test("overlayArtifactEndpoints recomputes pool eligibility from live health and static constraints", () => {
    const liveOk = {
      last_run_at: "2026-06-13T00:00:00.000Z",
      health_source: "live-cron-prober",
      surfaces: [
        {
          surface_id: "rpc-ok",
          status: "ok",
          last_checked: "2026-06-13T00:00:00.000Z",
        },
        {
          surface_id: "api-ok",
          status: "ok",
          last_checked: "2026-06-13T00:00:00.000Z",
        },
        {
          surface_id: "auth-ok",
          status: "ok",
          last_checked: "2026-06-13T00:00:00.000Z",
        },
        {
          surface_id: "unsafe-ok",
          status: "ok",
          last_checked: "2026-06-13T00:00:00.000Z",
        },
      ],
    };
    const out = overlayArtifactEndpoints(
      {
        summary: { by_status: { failed: 4 }, pool_eligible_count: 0 },
        endpoints: [
          {
            surface_id: "rpc-ok",
            kind: "subtensor-rpc",
            auth_required: false,
            public_safe: true,
            status: "failed",
          },
          {
            surface_id: "api-ok",
            kind: "subnet-api",
            auth_required: false,
            public_safe: true,
            status: "failed",
          },
          {
            surface_id: "auth-ok",
            kind: "subtensor-rpc",
            auth_required: true,
            public_safe: true,
            status: "failed",
          },
          {
            surface_id: "unsafe-ok",
            kind: "subtensor-wss",
            auth_required: false,
            public_safe: false,
            status: "failed",
          },
        ],
      },
      liveOk,
    );

    assert.equal(
      out.endpoints.find((e) => e.surface_id === "rpc-ok").pool_eligible,
      true,
    );
    assert.deepEqual(
      out.endpoints.find((e) => e.surface_id === "rpc-ok")
        .pool_eligibility_reasons,
      ["eligible"],
    );
    assert.equal(
      out.endpoints.find((e) => e.surface_id === "api-ok").pool_eligible,
      false,
    );
    assert.deepEqual(
      out.endpoints.find((e) => e.surface_id === "api-ok")
        .pool_eligibility_reasons,
      ["not-bittensor-base-layer"],
    );
    assert.equal(
      out.endpoints.find((e) => e.surface_id === "auth-ok").pool_eligible,
      false,
    );
    assert.deepEqual(
      out.endpoints.find((e) => e.surface_id === "auth-ok")
        .pool_eligibility_reasons,
      ["auth-required"],
    );
    assert.equal(
      out.endpoints.find((e) => e.surface_id === "unsafe-ok").pool_eligible,
      false,
    );
    assert.deepEqual(
      out.endpoints.find((e) => e.surface_id === "unsafe-ok")
        .pool_eligibility_reasons,
      ["not-public-safe"],
    );
    assert.equal(out.summary.pool_eligible_count, 1);
  });

  test("overlayArtifactEndpoints blanks endpoints to unknown when the store is cold", () => {
    const artifact = {
      endpoints: [
        {
          surface_id: "7:subnet-api:x",
          status: "ok",
          health_source: "probe-derived",
          latency_ms: 10,
          pool_eligible: true,
        },
      ],
    };
    const out = overlayArtifactEndpoints(artifact, null);
    assert.equal(out.endpoints[0].status, "unknown");
    assert.equal(out.endpoints[0].health_source, "unavailable");
    assert.equal(out.endpoints[0].health_stale, true);
    assert.equal(out.endpoints[0].latency_ms, null);
    assert.equal(out.endpoints[0].pool_eligible, false);
    assert.equal(out.operational_observed_at, null);
    assert.equal(out.health_source, "unavailable");
  });

  test("overlayArtifactEndpoints returns null when there is no endpoints array", () => {
    assert.equal(overlayArtifactEndpoints({ netuid: 7 }, live), null);
    assert.equal(overlayArtifactEndpoints(null, live), null);
  });

  test("overlayArtifactEndpoints leaves not-monitored endpoints untouched", () => {
    const artifact = {
      endpoints: [
        {
          surface_id: "docs-1",
          monitoring_status: "not_monitored",
          status: "unknown",
          health_source: "not-monitored",
          health_stale: false,
          pool_eligible: false,
          url: "https://docs",
        },
        {
          surface_id: "mon-absent",
          monitoring_status: "monitored",
          status: "ok",
          health_source: "probe-derived",
          pool_eligible: true,
          url: "https://mon",
        },
      ],
    };
    const out = overlayArtifactEndpoints(artifact, live);
    // not-monitored is a stable classification, never overlaid to unavailable.
    assert.equal(out.endpoints[0].health_source, "not-monitored");
    assert.equal(out.endpoints[0].health_stale, false);
    assert.equal(out.endpoints[0].status, "unknown");
    // a monitored surface absent from the live snapshot does read unavailable.
    assert.equal(out.endpoints[1].health_source, "unavailable");
    assert.equal(out.endpoints[1].status, "unknown");
  });

  test("overlayArtifactEndpoints keeps a live-ok endpoint eligible and preserves a non-ok error", () => {
    const liveOk = {
      last_run_at: "2026-06-13T00:00:00.000Z",
      health_source: "live-cron-prober",
      surfaces: [
        {
          surface_id: "ok-one",
          status: "ok",
          classification: "live",
          latency_ms: 42,
          last_ok: "2026-06-13T00:00:00.000Z",
          last_checked: "2026-06-13T00:00:00.000Z",
        },
        {
          surface_id: "deg-one",
          status: "degraded",
          classification: "slow",
          latency_ms: null,
          last_ok: null,
          last_checked: "2026-06-13T00:00:00.000Z",
        },
      ],
    };
    const out = overlayArtifactEndpoints(
      {
        endpoints: [
          {
            surface_id: "ok-one",
            status: "failed",
            kind: "subtensor-rpc",
            auth_required: false,
            public_safe: true,
            pool_eligible: false,
          },
          { surface_id: "deg-one", status: "ok", error: "prev-error" },
        ],
      },
      liveOk,
    );
    assert.equal(out.endpoints[0].status, "ok");
    assert.equal(out.endpoints[0].pool_eligible, true);
    assert.equal(out.endpoints[0].latency_ms, 42);
    assert.equal(out.endpoints[0].error, null); // ok → error cleared
    // non-ok live status keeps the static error and stays ineligible.
    assert.equal(out.endpoints[1].status, "degraded");
    assert.equal(out.endpoints[1].pool_eligible, false);
    assert.equal(out.endpoints[1].error, "prev-error");
  });
});

describe("worker live health overlay on composed routes", () => {
  const seedComposedArchive = ({
    overview = { netuid: 7, health: null },
    catalog = { netuid: 7, services: [] },
  } = {}) => ({
    async get(key) {
      if (String(key).includes("overview/7.json")) {
        return {
          async json() {
            return overview;
          },
        };
      }
      if (String(key).includes("agent-catalog/7.json")) {
        return {
          async json() {
            return catalog;
          },
        };
      }
      return null;
    },
  });

  test("/api/v1/subnets/7/overview overlays live health from KV", async () => {
    const env = createLocalArtifactEnv({
      METAGRAPH_CONTROL: kvWith({
        "health:current": {
          last_run_at: FRESH_RUN,
          subnets: [
            { netuid: 7, status: "failed", surface_count: 1, ok_count: 0 },
          ],
          surfaces: [],
        },
      }),
      METAGRAPH_ARCHIVE: seedComposedArchive(),
    });
    const res = await handleRequest(req("/api/v1/subnets/7/overview"), env, {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.health.status, "failed");
    assert.equal(body.meta.source, "live-cron-prober");
    assert.equal(body.meta.operational_observed_at, FRESH_RUN);
  });

  test("/api/v1/agent-catalog/7 carries the live freshness contract", async () => {
    const env = createLocalArtifactEnv({
      METAGRAPH_CONTROL: kvWith({
        "health:current": {
          last_run_at: FRESH_RUN,
          subnets: [{ netuid: 7, status: "ok" }],
          surfaces: [],
        },
      }),
      METAGRAPH_ARCHIVE: seedComposedArchive(),
    });
    const res = await handleRequest(req("/api/v1/agent-catalog/7"), env, {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.meta.source, "live-cron-prober");
    assert.equal(body.meta.operational_observed_at, FRESH_RUN);
  });

  test("/api/v1/agent-catalog overlays the index per-subnet status", async () => {
    const env = createLocalArtifactEnv({
      METAGRAPH_CONTROL: kvWith({
        "health:current": {
          last_run_at: FRESH_RUN,
          subnets: [{ netuid: 7, status: "degraded" }],
          surfaces: [],
        },
      }),
    });
    const res = await handleRequest(req("/api/v1/agent-catalog"), env, {});
    assert.equal(res.status, 200);
    assert.equal((await res.json()).meta.source, "live-cron-prober");
  });

  test("live overlays preserve missing composed artifact 404s", async () => {
    const env = createLocalArtifactEnv({
      METAGRAPH_CONTROL: kvWith({
        "health:current": {
          last_run_at: FRESH_RUN,
          subnets: [{ netuid: 1, status: "ok" }],
          surfaces: [],
        },
      }),
      METAGRAPH_ARCHIVE: {
        async get() {
          return null;
        },
      },
    });

    const overview = await handleRequest(
      req("/api/v1/subnets/999999/overview"),
      env,
      {},
    );
    assert.equal(overview.status, 404);
    assert.equal((await overview.json()).ok, false);

    const catalog = await handleRequest(
      req("/api/v1/agent-catalog/999999"),
      env,
      {},
    );
    assert.equal(catalog.status, 404);
    assert.equal((await catalog.json()).ok, false);
  });

  test("composed routes fall back to the static artifact when KV+D1 are cold", async () => {
    const env = createLocalArtifactEnv({
      METAGRAPH_ARCHIVE: seedComposedArchive(),
    });
    const res = await handleRequest(req("/api/v1/subnets/7/overview"), env, {});
    assert.equal(res.status, 200);
    assert.notEqual((await res.json()).meta.source, "live-cron-prober");
  });

  const seedDetailArchive = (detail) => ({
    async get(key) {
      if (!String(key).includes("subnets/7.json")) return null;
      return {
        async json() {
          return detail;
        },
        async text() {
          return JSON.stringify(detail);
        },
      };
    },
  });

  test("/api/v1/subnets/7 overlays per-endpoint health live (no longer baked)", async () => {
    const detail = {
      schema_version: 1,
      generated_at: "2026-06-12T21:00:00.000Z",
      subnet: { netuid: 7 },
      summary: { by_status: { ok: 1 }, pool_eligible_count: 1 },
      endpoints: [
        {
          id: "endpoint-s1",
          surface_id: "s1",
          netuid: 7,
          kind: "subnet-api",
          url: "https://s1",
          provider: "p",
          status: "ok",
          classification: "live",
          health_source: "probe-derived",
          health_stale: false,
          observed_at: "2026-06-12T21:00:00.000Z",
          last_ok: "2026-06-12T21:00:00.000Z",
          last_checked: "2026-06-12T21:00:00.000Z",
          latency_ms: 900,
          pool_eligible: true,
        },
      ],
    };
    const env = createLocalArtifactEnv({
      METAGRAPH_CONTROL: kvWith({
        "health:current": {
          last_run_at: FRESH_RUN,
          health_source: "live-cron-prober",
          surfaces: [
            {
              surface_id: "s1",
              netuid: 7,
              status: "failed",
              classification: "down",
              latency_ms: 5,
              last_ok: "2026-06-12T23:00:00.000Z",
              last_checked: "2026-06-13T00:00:00.000Z",
            },
          ],
        },
      }),
      METAGRAPH_ARCHIVE: seedDetailArchive(detail),
    });
    const res = await handleRequest(req("/api/v1/subnets/7"), env, {});
    assert.equal(res.status, 200);
    const ep = (await res.clone().json()).data.endpoints[0];
    assert.equal(ep.status, "failed"); // live status, not the baked "ok"
    assert.equal(ep.health_source, "live-cron-prober");
    assert.equal(ep.health_stale, false);
    assert.equal(ep.pool_eligible, false); // live failed → ineligible
    assert.equal(ep.observed_at, "2026-06-13T00:00:00.000Z");
    assert.equal((await res.json()).meta.source, "live-cron-prober");
  });

  test("/api/v1/subnets/7 endpoints read `unknown` when the live store is cold", async () => {
    const detail = {
      subnet: { netuid: 7 },
      endpoints: [
        {
          id: "endpoint-s1",
          surface_id: "s1",
          netuid: 7,
          kind: "subnet-api",
          url: "https://s1",
          provider: "p",
          status: "ok",
          health_source: "probe-derived",
          health_stale: false,
          observed_at: "2026-06-12T21:00:00.000Z",
          pool_eligible: true,
        },
      ],
    };
    const env = createLocalArtifactEnv({
      METAGRAPH_ARCHIVE: seedDetailArchive(detail),
    });
    const res = await handleRequest(req("/api/v1/subnets/7"), env, {});
    assert.equal(res.status, 200);
    const ep = (await res.json()).data.endpoints[0];
    assert.equal(ep.status, "unknown"); // never the baked "ok"
    assert.equal(ep.health_source, "unavailable");
    assert.equal(ep.health_stale, true);
  });

  test("raw /metagraph/subnets/7.json overlays per-endpoint health live too", async () => {
    const detail = {
      subnet: { netuid: 7 },
      endpoints: [
        {
          id: "endpoint-s1",
          surface_id: "s1",
          netuid: 7,
          kind: "subnet-api",
          url: "https://s1",
          provider: "p",
          status: "ok",
          health_source: "probe-derived",
          health_stale: false,
          observed_at: "2026-06-12T21:00:00.000Z",
          pool_eligible: true,
        },
      ],
    };
    const env = createLocalArtifactEnv({
      METAGRAPH_CONTROL: kvWith({
        "health:current": {
          last_run_at: FRESH_RUN,
          health_source: "live-cron-prober",
          surfaces: [
            {
              surface_id: "s1",
              netuid: 7,
              status: "degraded",
              classification: "slow",
              latency_ms: 50,
              last_ok: "2026-06-12T23:00:00.000Z",
              last_checked: "2026-06-13T00:00:00.000Z",
            },
          ],
        },
      }),
      METAGRAPH_ARCHIVE: seedDetailArchive(detail),
    });
    const res = await handleRequest(req("/metagraph/subnets/7.json"), env, {});
    assert.equal(res.status, 200);
    const body = await res.json();
    // Raw artifact path is no longer byte-identical: operational health is live.
    assert.equal(body.endpoints[0].status, "degraded");
    assert.equal(body.endpoints[0].health_source, "live-cron-prober");
    assert.equal(body.endpoints[0].health_stale, false);
  });

  test("/api/v1/health serves `unknown` when the live store is cold (live-only)", async () => {
    const env = createLocalArtifactEnv();
    const res = await handleRequest(req("/api/v1/health"), env, {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.meta.source, "unavailable");
    assert.equal(body.data.global.surface_count, 0);
    assert.deepEqual(body.data.subnets, []);
  });

  test("/api/v1/subnets/7/health is `unknown` when cold — never 404, never baked", async () => {
    const env = createLocalArtifactEnv();
    const res = await handleRequest(req("/api/v1/subnets/7/health"), env, {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.summary.status, "unknown");
    assert.equal(body.data.health_source, "unavailable");
    assert.equal(body.meta.source, "unavailable");
  });

  test("composed overview no longer embeds a baked health status", async () => {
    // The built artifact carries health:null; cold reads must not surface a
    // stale status (the overlay would set it live in prod).
    const env = createLocalArtifactEnv({
      METAGRAPH_ARCHIVE: seedComposedArchive(),
    });
    const res = await handleRequest(req("/api/v1/subnets/7/overview"), env, {});
    const body = await res.json();
    assert.equal(body.data.health, null);
  });
});

describe("formatUptime (daily uptime history)", () => {
  test("groups by surface, sorts days, rolls window uptime from ok_count/samples", () => {
    const out = formatUptime({
      netuid: 7,
      window: "90d",
      rows: [
        {
          surface_id: "b",
          day: "2026-06-12",
          samples: 100,
          ok_count: 100,
          uptime_ratio: 1,
          avg_latency_ms: 50,
          status: "ok",
        },
        {
          surface_id: "a",
          day: "2026-06-13",
          samples: 100,
          ok_count: 90,
          uptime_ratio: 0.9,
          avg_latency_ms: 70,
          status: "degraded",
        },
        {
          surface_id: "a",
          day: "2026-06-12",
          samples: 100,
          ok_count: 80,
          uptime_ratio: 0.8,
          avg_latency_ms: 60,
          status: "degraded",
        },
      ],
    });
    assert.equal(out.netuid, 7);
    assert.equal(out.window, "90d");
    assert.equal(out.observed_at, null);
    assert.equal(out.source, "live-cron-prober");
    // sorted by surface_id (a before b)
    assert.equal(out.surfaces[0].surface_id, "a");
    assert.equal(out.surfaces[0].day_count, 2);
    assert.equal(out.surfaces[0].samples, 200);
    // window uptime = (80+90)/200 = 0.85, from summed counts (not avg of ratios)
    assert.equal(out.surfaces[0].uptime_ratio, 0.85);
    // days sorted ascending; internal ok_count dropped from the per-day series
    assert.equal(out.surfaces[0].days[0].day, "2026-06-12");
    assert.equal(out.surfaces[0].days[0].ok_count, undefined);
    assert.equal(out.surfaces[0].days[0].uptime_ratio, 0.8);
    // reliability is attached at the subnet level + per surface
    assert.equal(typeof out.reliability.score, "number");
    assert.equal(out.reliability.window, "90d");
    assert.equal(out.reliability.surface_count, 2);
    assert.equal(typeof out.surfaces[0].reliability.score, "number");
    assert.match(out.surfaces[0].reliability.grade, /^[A-F]$/);
  });

  test("groups renamed uptime rows by stable surface_key", () => {
    const out = formatUptime({
      netuid: 7,
      window: "90d",
      rows: [
        {
          surface_id: "7:api:old",
          surface_key: "srf-api0000000000",
          day: "2026-06-12",
          samples: 100,
          ok_count: 80,
          uptime_ratio: 0.8,
          avg_latency_ms: 60,
          status: "degraded",
        },
        {
          surface_id: "7:api:new",
          surface_key: "srf-api0000000000",
          day: "2026-06-13",
          samples: 100,
          ok_count: 100,
          uptime_ratio: 1,
          avg_latency_ms: 40,
          status: "ok",
        },
      ],
    });
    assert.equal(out.surfaces.length, 1);
    assert.equal(out.surfaces[0].surface_id, "7:api:new");
    assert.equal(out.surfaces[0].samples, 200);
    assert.equal(out.surfaces[0].uptime_ratio, 0.9);
    assert.equal(out.reliability.surface_count, 1);
  });

  test("returns an empty series + null reliability for no rows", () => {
    const out = formatUptime({ netuid: 7, window: "1y", rows: [] });
    assert.deepEqual(out.surfaces, []);
    assert.equal(out.reliability, null);
  });

  test("propagates observedAt into observed_at", () => {
    const ts = "2026-06-22T00:00:00.000Z";
    const out = formatUptime({
      netuid: 7,
      window: "90d",
      observedAt: ts,
      rows: [],
    });
    assert.equal(out.observed_at, ts);
  });

  test("handles null ratios/latency, missing status, zero samples, and no window", () => {
    const out = formatUptime({
      netuid: 7,
      rows: [
        {
          surface_id: "z",
          day: "2026-06-13",
          samples: 0,
          ok_count: 0,
          uptime_ratio: null,
          avg_latency_ms: null,
        },
      ],
    });
    assert.equal(out.window, null); // window omitted → null
    assert.equal(out.surfaces[0].uptime_ratio, null); // samples 0 → null ratio
    assert.equal(out.surfaces[0].days[0].uptime_ratio, null);
    assert.equal(out.surfaces[0].days[0].avg_latency_ms, null);
    assert.equal(out.surfaces[0].days[0].status, "unknown"); // missing → unknown
  });
});

describe("worker /api/v1/subnets/{netuid}/uptime route", () => {
  test("serves the live daily uptime rollup from D1", async () => {
    const UPTIME_RUN = "2026-06-22T01:00:00.000Z";
    const env = createLocalArtifactEnv({
      METAGRAPH_HEALTH_DB: d1With([
        {
          surface_id: "7:subnet-api:x",
          day: "2026-06-13",
          samples: 700,
          ok_count: 700,
          uptime_ratio: 1,
          avg_latency_ms: 40,
          status: "ok",
        },
      ]),
      METAGRAPH_CONTROL: kvWith({ "health:meta": { last_run_at: UPTIME_RUN } }),
    });
    const res = await handleRequest(
      req("/api/v1/subnets/7/uptime?window=1y"),
      env,
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.netuid, 7);
    assert.equal(body.data.window, "1y");
    assert.equal(body.data.observed_at, UPTIME_RUN);
    assert.equal(body.data.surfaces[0].surface_id, "7:subnet-api:x");
    assert.equal(body.data.surfaces[0].uptime_ratio, 1);
    assert.equal(body.meta.source, "live-cron-prober");
    assert.equal(body.meta.generated_at, UPTIME_RUN);
  });

  test("defaults to 90d and returns an empty series when D1 is cold", async () => {
    const env = createLocalArtifactEnv();
    const res = await handleRequest(req("/api/v1/subnets/7/uptime"), env, {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.window, "90d");
    assert.deepEqual(body.data.surfaces, []);
  });

  test("rejects an invalid window with 400", async () => {
    const env = createLocalArtifactEnv();
    for (const windowParam of ["5y", "constructor", "__proto__"]) {
      const res = await handleRequest(
        req(`/api/v1/subnets/7/uptime?window=${windowParam}`),
        env,
        {},
      );
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error.code, "invalid_query");
    }
  });
});

describe("computeReliability (score from uptime history)", () => {
  test("returns null subnet score when there is no probe data", () => {
    assert.equal(computeReliability([]).subnet, null);
    assert.deepEqual(computeReliability([]).surfaces, {});
  });

  test("scores sample-weighted uptime with a mild latency penalty", () => {
    const out = computeReliability(
      [
        {
          surface_id: "a",
          day: "2026-06-12",
          samples: 720,
          ok_count: 720,
          avg_latency_ms: 200,
        },
        {
          surface_id: "a",
          day: "2026-06-13",
          samples: 720,
          ok_count: 700,
          avg_latency_ms: 300,
        },
        {
          surface_id: "b",
          day: "2026-06-12",
          samples: 720,
          ok_count: 360,
          avg_latency_ms: 1500,
        },
      ],
      { window: "30d", now: "2026-06-13T00:00:00.000Z" },
    );
    // subnet aggregate: (720+700+360)/2160 = 0.8241
    assert.equal(out.subnet.uptime_ratio, 0.8241);
    assert.equal(out.subnet.sample_count, 2160);
    assert.equal(out.subnet.surface_count, 2);
    assert.equal(out.subnet.window, "30d");
    assert.equal(out.subnet.computed_at, "2026-06-13T00:00:00.000Z");
    // healthy surface a -> high score; failing+slow surface b -> low
    assert.ok(out.surfaces.a.score > out.surfaces.b.score);
    assert.equal(out.surfaces.b.grade, "F");
  });

  test("aggregates a renamed surface as ONE bucket via stable surface_key", () => {
    // The same physical surface across a rename: one stable surface_key, two
    // different surface_id values on either side of the rename boundary. It must
    // NOT split into two surfaces (which would inflate surface_count and
    // fragment the per-surface score).
    const out = computeReliability(
      [
        {
          surface_id: "7:api:old",
          surface_key: "srf-stableapi0000",
          day: "2026-06-12",
          samples: 100,
          ok_count: 80,
          avg_latency_ms: 100,
        },
        {
          surface_id: "7:api:new",
          surface_key: "srf-stableapi0000",
          day: "2026-06-13",
          samples: 100,
          ok_count: 100,
          avg_latency_ms: 100,
        },
      ],
      { window: "30d", now: "2026-06-13T00:00:00.000Z" },
    );
    assert.equal(out.subnet.surface_count, 1);
    assert.equal(out.subnet.sample_count, 200);
    // surfaces map is keyed by the stable surface_key, not either surface_id.
    assert.deepEqual(Object.keys(out.surfaces), ["srf-stableapi0000"]);
    assert.equal(out.surfaces["srf-stableapi0000"].uptime_ratio, 0.9);
    assert.equal(out.surfaces["7:api:old"], undefined);
  });

  test("weights latency by healthy readings and reports latency_sample_count", () => {
    const out = computeReliability(
      [
        // Same day-means as a samples-weighted view, but the failure-heavy day
        // carries few healthy readings, so it must barely move the mean.
        {
          surface_id: "a",
          day: "2026-06-12",
          samples: 720,
          ok_count: 36,
          avg_latency_ms: 100,
          latency_samples: 36,
        },
        {
          surface_id: "a",
          day: "2026-06-13",
          samples: 720,
          ok_count: 720,
          avg_latency_ms: 200,
          latency_samples: 720,
        },
      ],
      { window: "30d", now: "2026-06-13T00:00:00.000Z" },
    );
    // (100*36 + 200*720) / 756 = 195 (healthy-weighted), NOT 150 (samples-weighted).
    assert.equal(out.subnet.avg_latency_ms, 195);
    assert.equal(out.subnet.latency_sample_count, 756);
    assert.equal(out.surfaces.a.latency_sample_count, 756);
    // sample_count remains the total probe count behind uptime.
    assert.equal(out.subnet.sample_count, 1440);
  });

  test("legacy rows without latency_samples fall back to total samples", () => {
    const out = computeReliability([
      {
        surface_id: "a",
        day: "2026-06-12",
        samples: 100,
        ok_count: 90,
        avg_latency_ms: 300,
      },
    ]);
    assert.equal(out.subnet.avg_latency_ms, 300);
    assert.equal(out.subnet.latency_sample_count, 100);
  });

  test("latency penalty is bounded and only applies above 500ms", () => {
    // perfect uptime, fast -> 100
    assert.equal(
      scoreFromStats({ samples: 100, okCount: 100, avgLatencyMs: 200 }).score,
      100,
    );
    // perfect uptime, 1500ms -> 100 - (1000/100) = 90
    assert.equal(
      scoreFromStats({ samples: 100, okCount: 100, avgLatencyMs: 1500 }).score,
      90,
    );
    // penalty caps at 15 even at extreme latency
    assert.equal(
      scoreFromStats({ samples: 100, okCount: 100, avgLatencyMs: 99999 }).score,
      85,
    );
    // no samples -> null
    assert.equal(
      scoreFromStats({ samples: 0, okCount: 0, avgLatencyMs: 10 }),
      null,
    );
  });

  test("a sub-perfect ratio that rounds to 1 is not reported as a perfect 1", () => {
    // 24999/25000 = 0.99996; (0.99996).toFixed(4) === "1.0000", which would
    // otherwise overstate a 99.996%-uptime subnet as a perfect-uptime "100%"
    // badge. Clamp the displayed ratio to the largest 4-decimal value below 1.
    assert.equal(
      scoreFromStats({ samples: 25000, okCount: 24999, avgLatencyMs: null })
        .uptime_ratio,
      0.9999,
    );
    // a genuine okCount === samples ratio still reports an exact 1.
    assert.equal(
      scoreFromStats({ samples: 25000, okCount: 25000, avgLatencyMs: null })
        .uptime_ratio,
      1,
    );
    // an ordinary sub-1 ratio is unchanged (rounded to 4 decimals as before).
    assert.equal(
      scoreFromStats({ samples: 10000, okCount: 9983, avgLatencyMs: null })
        .uptime_ratio,
      0.9983,
    );
  });

  test("covers grade B, null latency, missing day, and nullish rows", () => {
    // grade B (95-98)
    assert.equal(
      scoreFromStats({ samples: 100, okCount: 97, avgLatencyMs: 200 }).grade,
      "B",
    );
    // null latency -> no penalty, avg_latency_ms reported null
    const noLatency = scoreFromStats({
      samples: 100,
      okCount: 90,
      avgLatencyMs: null,
    });
    assert.equal(noLatency.avg_latency_ms, null);
    assert.equal(noLatency.score, 90);
    // nullish rows -> empty result (no throw)
    assert.equal(computeReliability(undefined).subnet, null);
    assert.equal(computeReliability(null).subnet, null);
    // a row with no day + no latency still scores from uptime
    const out = computeReliability([
      { surface_id: "a", samples: 100, ok_count: 100 },
    ]);
    assert.equal(out.subnet.score, 100);
    assert.equal(out.subnet.avg_latency_ms, null);
    assert.equal(out.subnet.day_count, 0);
  });
});

describe("loadSubnetReliability (D1-backed)", () => {
  function uptimeDb(rows) {
    return {
      prepare() {
        return {
          bind() {
            return this;
          },
          async all() {
            return { results: rows };
          },
        };
      },
    };
  }

  test("returns null when D1 is unbound", async () => {
    assert.equal(
      await loadSubnetReliability({ db: undefined, netuid: 7 }),
      null,
    );
  });

  test("scores from surface_uptime_daily rows", async () => {
    const out = await loadSubnetReliability({
      db: uptimeDb([
        {
          surface_id: "a",
          day: "2026-06-12",
          samples: 720,
          ok_count: 720,
          avg_latency_ms: 120,
        },
        {
          surface_id: "b",
          day: "2026-06-12",
          samples: 720,
          ok_count: 360,
          avg_latency_ms: 900,
        },
      ]),
      netuid: 7,
      now: "2026-06-13T00:00:00.000Z",
    });
    assert.equal(out.window, "30d");
    assert.equal(out.surface_count, 2);
    assert.equal(out.uptime_ratio, 0.75); // (720+360)/1440
    assert.equal(out.computed_at, "2026-06-13T00:00:00.000Z");
  });

  test("counts a renamed surface once across the rename boundary", async () => {
    // The query GROUP BYs COALESCE(surface_key, surface_id) per day and emits
    // MAX(surface_id) per group, so a surface renamed mid-window yields rows with
    // ONE stable surface_key but a different surface_id on each side of the
    // rename. surface_count must stay 1 (not inflate to 2).
    const out = await loadSubnetReliability({
      db: uptimeDb([
        {
          surface_id: "7:api:new",
          surface_key: "srf-stableapi0000",
          day: "2026-06-13",
          samples: 720,
          ok_count: 720,
          avg_latency_ms: 120,
        },
        {
          surface_id: "7:api:old",
          surface_key: "srf-stableapi0000",
          day: "2026-06-12",
          samples: 720,
          ok_count: 540,
          avg_latency_ms: 120,
        },
      ]),
      netuid: 7,
      now: "2026-06-14T00:00:00.000Z",
    });
    assert.equal(out.surface_count, 1);
    assert.equal(out.uptime_ratio, 0.875); // (720+540)/1440
  });

  test("returns null (not throw) when the query fails", async () => {
    const out = await loadSubnetReliability({
      db: {
        prepare() {
          throw new Error("d1 down");
        },
      },
      netuid: 7,
    });
    assert.equal(out, null);
  });

  test("returns null when there is no history yet", async () => {
    assert.equal(
      await loadSubnetReliability({ db: uptimeDb([]), netuid: 7 }),
      null,
    );
  });
});

describe("loadReliabilityAggregate (D1-backed, one query for many subnets)", () => {
  // Fake D1 returning a single aggregate row from .first(); also records the
  // bound params so we can assert the netuid IN-list was built correctly.
  function aggregateDb(row, sink = {}) {
    return {
      prepare(sql) {
        sink.sql = sql;
        return {
          bind(...params) {
            sink.params = params;
            return this;
          },
          async first() {
            return row;
          },
        };
      },
    };
  }

  test("returns null when D1 is unbound or no netuids given", async () => {
    assert.equal(
      await loadReliabilityAggregate({ db: undefined, netuids: [7] }),
      null,
    );
    assert.equal(
      await loadReliabilityAggregate({ db: aggregateDb({}), netuids: [] }),
      null,
    );
  });

  test("scores the summed samples/ok_count via scoreFromStats", async () => {
    const sink = {};
    const out = await loadReliabilityAggregate({
      db: aggregateDb(
        { samples: 1440, ok_count: 1080, avg_latency_ms: 600 },
        sink,
      ),
      netuids: [7, 12],
      now: "2026-06-13T00:00:00.000Z",
    });
    // (1080/1440)=0.75 uptime; latency 600 → -1 penalty → score 74, grade F.
    assert.deepEqual(
      out,
      scoreFromStats({ samples: 1440, okCount: 1080, avgLatencyMs: 600 }),
    );
    assert.equal(out.uptime_ratio, 0.75);
    // One IN-list query over a deduped, sorted netuid set + the day cutoff.
    assert.match(sink.sql, /netuid IN \(\?,\?\)/);
    assert.deepEqual(sink.params, [7, 12, "2026-05-14"]);
  });

  test("weights the latency mean by healthy readings, not total probes", async () => {
    // Regression for the badge under-scoring failure-heavy days: avg_latency_ms
    // is a success-only mean, so re-aggregating it must weight by latency_samples
    // (healthy readings), not samples (total probes incl. failures). Mirrors the
    // canonical dailyLatencyColumns() helper. The mocked .first() can't run SQL,
    // so assert the weighting lives in the emitted query.
    const sink = {};
    await loadReliabilityAggregate({
      db: aggregateDb({ samples: 10, ok_count: 8 }, sink),
      netuids: [7],
    });
    assert.match(sink.sql, /COALESCE\(latency_samples, samples\)/);
    // The bare `avg_latency_ms * samples` total-probe weighting must be gone.
    assert.doesNotMatch(sink.sql, /avg_latency_ms \* samples\b/);
  });

  test("dedupes netuids and ignores non-integers", async () => {
    const sink = {};
    await loadReliabilityAggregate({
      db: aggregateDb({ samples: 10, ok_count: 10 }, sink),
      netuids: [7, 7, 12, "x", null, undefined],
    });
    assert.match(sink.sql, /netuid IN \(\?,\?\)/);
    assert.deepEqual(sink.params.slice(0, 2), [7, 12]);
  });

  test("no rows → null (no samples, by design)", async () => {
    assert.equal(
      await loadReliabilityAggregate({
        db: aggregateDb({
          samples: null,
          ok_count: null,
          avg_latency_ms: null,
        }),
        netuids: [7],
      }),
      null,
    );
    assert.equal(
      await loadReliabilityAggregate({
        db: aggregateDb(null),
        netuids: [7],
      }),
      null,
    );
  });

  test("returns null (not throw) when the query fails", async () => {
    assert.equal(
      await loadReliabilityAggregate({
        db: {
          prepare() {
            throw new Error("d1 down");
          },
        },
        netuids: [7],
      }),
      null,
    );
  });
});

describe("formatGlobalIncidents (cross-subnet ledger)", () => {
  test("groups incidents by netuid+surface and summarizes", () => {
    const out = formatGlobalIncidents({
      window: "30d",
      observedAt: "2026-06-13T00:00:00.000Z",
      maxIncidents: 1000,
      incidentRows: [
        {
          netuid: 7,
          surface_id: "a",
          started_at: 1000,
          ended_at: 5000,
          failed_samples: 3,
        },
        {
          netuid: 7,
          surface_id: "a",
          started_at: 20000,
          ended_at: 26000,
          failed_samples: 2,
        },
        {
          netuid: 23,
          surface_id: "b",
          started_at: 8000,
          ended_at: 9000,
          failed_samples: 1,
        },
      ],
    });
    assert.equal(out.summary.incident_count, 3);
    assert.equal(out.summary.affected_surface_count, 2);
    assert.equal(out.surfaces[0].netuid, 7); // sorted by netuid
    const sn7 = out.surfaces.find((s) => s.netuid === 7);
    assert.equal(sn7.incident_count, 2);
    assert.equal(sn7.downtime_ms, 10000); // 4000 + 6000
  });

  test("empty rows -> empty ledger; caps at maxIncidents", () => {
    assert.deepEqual(formatGlobalIncidents({ incidentRows: [] }).surfaces, []);
    const capped = formatGlobalIncidents({
      maxIncidents: 1,
      incidentRows: [
        {
          netuid: 1,
          surface_id: "x",
          started_at: 1,
          ended_at: 2,
          failed_samples: 1,
        },
        {
          netuid: 1,
          surface_id: "x",
          started_at: 3,
          ended_at: 4,
          failed_samples: 1,
        },
      ],
    });
    assert.equal(capped.summary.incident_count, 1);
  });
});

describe("global incidents route", () => {
  test("serves a schema-stable empty ledger when D1 is cold", async () => {
    const env = createLocalArtifactEnv();
    const res = await handleRequest(req("/api/v1/incidents"), env, {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(Array.isArray(body.data.surfaces), true);
    assert.equal(body.data.summary.incident_count, 0);
    assert.equal(body.meta.source, "live-cron-prober");
  });

  test("rejects an unsupported window", async () => {
    const env = createLocalArtifactEnv();
    const res = await handleRequest(
      req("/api/v1/incidents?window=5y"),
      env,
      {},
    );
    assert.equal(res.status, 400);
  });
});
