import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  OPERATIONAL_KINDS,
  buildGlobalHealth,
  formatTrends,
  mergeFreshness,
  mergeRpcEndpoints,
  overlayCatalogDetail,
  overlayCatalogIndex,
  overlayOverviewHealth,
  overlayRpcPoolEligibility,
  overlaySubnetHealth,
  parseLive,
  resolveLiveHealth,
  subnetBadgeStatus,
  summarizeRows,
} from "../src/health-serving.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";
import { handleRequest } from "../workers/api.mjs";

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
  test("unrecognized status key initializes its own count (|| 0 branch)", () => {
    // A status outside the known keys exercises the `counts[row.status] || 0`
    // default-init branch in summarizeRows. With no failed/degraded counts,
    // rollupStatus reports "ok".
    const out = summarizeRows([row("weird"), row("weird")]);
    assert.equal(out.status, "ok");
    assert.equal(out.failed_count, 0);
    assert.equal(out.ok_count, 0);
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
        { id: "a", status: "failed", consecutive_failures: 2, latency_ms: 70 },
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

describe("resolveLiveHealth (KV → D1 → null)", () => {
  const liveKv = {
    last_run_at: "2026-06-13T00:00:00.000Z",
    surfaces: [{ surface_id: "7:subnet-api:x", netuid: 7, status: "ok" }],
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

  test("falls back to fresh D1 surface_status rows when KV is cold", async () => {
    const observedCutoffs = [];
    const now = 1_700_000_600_000;
    const db = {
      prepare: (sql) => {
        assert.match(sql, /WHERE last_checked >= \?/);
        return {
          bind: (cutoff) => {
            observedCutoffs.push(cutoff);
            return {
              all: async () => ({
                results: [
                  {
                    surface_id: "7:subnet-api:x",
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
    assert.equal(live.subnets[0].netuid, 7);
    assert.equal(live.subnets[0].status, "failed");
    assert.deepEqual(observedCutoffs, [1_700_000_000_000]);
    // ms → ISO conversion for D1 timestamps.
    assert.match(live.surfaces[0].last_checked, /^20\d\d-/);
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
        surface_id: "7:subnet-api:x",
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
});

describe("worker live health overlay on composed routes", () => {
  test("/api/v1/subnets/7/overview overlays live health from KV", async () => {
    const env = createLocalArtifactEnv({
      METAGRAPH_CONTROL: kvWith({
        "health:current": {
          last_run_at: "2026-06-13T00:00:00.000Z",
          subnets: [
            { netuid: 7, status: "failed", surface_count: 1, ok_count: 0 },
          ],
          surfaces: [],
        },
      }),
    });
    const res = await handleRequest(req("/api/v1/subnets/7/overview"), env, {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.health.status, "failed");
    assert.equal(body.meta.source, "live-cron-prober");
    assert.equal(body.meta.operational_observed_at, "2026-06-13T00:00:00.000Z");
  });

  test("/api/v1/agent-catalog/7 carries the live freshness contract", async () => {
    const env = createLocalArtifactEnv({
      METAGRAPH_CONTROL: kvWith({
        "health:current": {
          last_run_at: "2026-06-13T00:00:00.000Z",
          subnets: [{ netuid: 7, status: "ok" }],
          surfaces: [],
        },
      }),
    });
    const res = await handleRequest(req("/api/v1/agent-catalog/7"), env, {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.meta.source, "live-cron-prober");
    assert.equal(body.meta.operational_observed_at, "2026-06-13T00:00:00.000Z");
  });

  test("/api/v1/agent-catalog overlays the index per-subnet status", async () => {
    const env = createLocalArtifactEnv({
      METAGRAPH_CONTROL: kvWith({
        "health:current": {
          last_run_at: "2026-06-13T00:00:00.000Z",
          subnets: [{ netuid: 7, status: "degraded" }],
          surfaces: [],
        },
      }),
    });
    const res = await handleRequest(req("/api/v1/agent-catalog"), env, {});
    assert.equal(res.status, 200);
    assert.equal((await res.json()).meta.source, "live-cron-prober");
  });

  test("composed routes fall back to the static artifact when KV+D1 are cold", async () => {
    const env = createLocalArtifactEnv();
    const res = await handleRequest(req("/api/v1/subnets/7/overview"), env, {});
    assert.equal(res.status, 200);
    assert.notEqual((await res.json()).meta.source, "live-cron-prober");
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
    const env = createLocalArtifactEnv();
    const res = await handleRequest(req("/api/v1/subnets/7/overview"), env, {});
    const body = await res.json();
    assert.equal(body.data.health, null);
  });
});
