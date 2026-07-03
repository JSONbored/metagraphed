import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  composeCompareData,
  growthRowsFromSamples,
  loadCompareSubnets,
  loadChainCalls,
  loadChainFees,
  loadNetworkActivity,
  loadGlobalIncidents,
  loadRegistryLeaderboards,
  loadSubnetHealthTrends,
  loadSubnetIncidents,
  loadSubnetPercentiles,
  loadSubnetUptime,
  parseAnalyticsWindow,
  parseCompareDimensionList,
  parseCompareDimensions,
  parseCompareNetuidList,
  parseCompareNetuids,
  parseUptimeWindow,
  profilesProjectionFromRows,
} from "../src/analytics-live.mjs";
import { buildOpenApiArtifact } from "../src/contracts.mjs";
import { loadOpenApiComponentSchemas } from "../scripts/openapi-components.mjs";

const NETUID = 7;
const OBSERVED_AT = "2026-06-24T12:00:00.000Z";

function d1(rowsBySql = {}) {
  return async (sql, _params) => {
    for (const [pattern, rows] of Object.entries(rowsBySql)) {
      if (new RegExp(pattern).test(sql)) return rows;
    }
    return [];
  };
}

describe("analytics-live compare helpers", () => {
  test("parseCompareNetuids deduplicates while preserving order", () => {
    assert.deepEqual(parseCompareNetuids("1,7,1,64"), [1, 7, 64]);
    assert.equal(parseCompareNetuids("not-valid"), null);
  });

  test("parseCompareNetuidList validates MCP array input", () => {
    assert.deepEqual(parseCompareNetuidList([1, 7, 1]), [1, 7]);
    assert.equal(parseCompareNetuidList([]), null);
    assert.equal(parseCompareNetuidList([1, -1]), null);
  });

  test("composeCompareData keeps unknown subnets found:false", () => {
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
    assert.equal(data.subnets[1].found, false);
    assert.equal(data.subnets[0].structure.completeness_score, 80);
  });

  test("composeCompareData validates against CompareArtifact", async () => {
    const generatedAt = "2026-06-24T12:00:00.000Z";
    const openapi = buildOpenApiArtifact(
      generatedAt,
      await loadOpenApiComponentSchemas(generatedAt),
    );
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile({
      $id: "https://metagraph.sh/test/compare-artifact-live.json",
      components: openapi.components,
      $ref: "#/components/schemas/CompareArtifact",
    });
    const data = composeCompareData({
      requestedNetuids: [1, 2],
      dimensions: ["structure", "economics", "health"],
      subnetMeta: new Map([
        [1, { name: "Apex", slug: "apex" }],
        [2, { name: "Beta", slug: "beta" }],
      ]),
      structureRows: [
        {
          netuid: 1,
          completeness_score: 80,
          surface_count: 5,
          operational_interface_count: 2,
        },
      ],
      economicsRows: [{ netuid: 2, open_slots: 3 }],
      healthRows: [
        { netuid: 1, surface_count: 5, ok_count: 4, avg_latency_ms: 120 },
      ],
      observedAt: generatedAt,
    });
    assert.equal(validate(data), true, ajv.errorsText(validate.errors));
  });
});

describe("analytics-live projections", () => {
  test("profilesProjectionFromRows builds subnetMeta + mostComplete", () => {
    const { subnetMeta, mostComplete } = profilesProjectionFromRows([
      {
        netuid: 1,
        slug: "apex",
        name: "Apex",
        completeness_score: 80,
        surface_count: 5,
        operational_interface_count: 2,
      },
    ]);
    assert.equal(subnetMeta.get(1).slug, "apex");
    assert.equal(mostComplete[0].operational_interface_count, 2);
  });

  test("growthRowsFromSamples computes completeness deltas", () => {
    assert.deepEqual(
      growthRowsFromSamples([
        { netuid: 1, completeness_score: 40 },
        { netuid: 1, completeness_score: 55 },
        { netuid: 2, completeness_score: null },
      ]),
      [
        { netuid: 1, delta: 15 },
        { netuid: 2, delta: null },
      ],
    );
  });

  test("growthRowsFromSamples ignores a leading null score when latching first", () => {
    // A subnet not yet profiled on its earliest in-window day emits a NULL
    // completeness_score first; `first` must latch the first *real* score, not
    // the NULL, so its growth still counts. Regression for the "fastest-growing"
    // leaderboard silently dropping such subnets.
    assert.deepEqual(
      growthRowsFromSamples([
        { netuid: 9, completeness_score: null },
        { netuid: 9, completeness_score: 10 },
        { netuid: 9, completeness_score: 90 },
      ]),
      [{ netuid: 9, delta: 80 }],
    );
  });

  test("growthRowsFromSamples ignores a trailing null score when latching last", () => {
    // Symmetric guard: a NULL on the newest day must not pin `last` to null and
    // collapse the delta — `last` latches the last real score.
    assert.deepEqual(
      growthRowsFromSamples([
        { netuid: 4, completeness_score: 50 },
        { netuid: 4, completeness_score: 70 },
        { netuid: 4, completeness_score: null },
      ]),
      [{ netuid: 4, delta: 20 }],
    );
  });

  test("growthRowsFromSamples treats a zero first score as a real sample", () => {
    // completeness_score 0 is a valid score, not "missing" — it must anchor the
    // delta so a 0→60 climb reads as +60, not null.
    assert.deepEqual(
      growthRowsFromSamples([
        { netuid: 7, completeness_score: 0 },
        { netuid: 7, completeness_score: 60 },
      ]),
      [{ netuid: 7, delta: 60 }],
    );
  });
});

describe("analytics-live loaders", () => {
  test("loadSubnetUptime returns schema-stable empty surfaces on cold D1", async () => {
    const data = await loadSubnetUptime(d1(), NETUID, {
      window: "90d",
      observedAt: OBSERVED_AT,
    });
    assert.equal(data.netuid, NETUID);
    assert.equal(data.window, "90d");
    assert.deepEqual(data.surfaces, []);
  });

  test("loadSubnetUptime aggregates daily rows into per-surface history", async () => {
    const data = await loadSubnetUptime(
      d1({
        "FROM surface_uptime_daily": [
          {
            surface_id: "api-root",
            surface_key: "api-root",
            day: "2026-06-01",
            samples: 50,
            ok_count: 45,
            uptime_ratio: 0.9,
            avg_latency_ms: 90,
            p50: 80,
            p95: 110,
            p99: 130,
            status: "ok",
          },
        ],
      }),
      NETUID,
      { window: "1y", observedAt: OBSERVED_AT },
    );
    assert.equal(data.window, "1y");
    assert.equal(data.surfaces.length, 1);
    assert.equal(data.surfaces[0].samples, 50);
    assert.equal(data.surfaces[0].days[0].uptime_ratio, 0.9);
  });

  test("loadSubnetHealthTrends returns schema-stable empty surfaces on cold D1", async () => {
    const data = await loadSubnetHealthTrends(d1(), NETUID, {
      observedAt: OBSERVED_AT,
    });
    assert.equal(data.netuid, NETUID);
    assert.equal(data.observed_at, OBSERVED_AT);
    assert.deepEqual(data.windows["7d"].surfaces, []);
    assert.deepEqual(data.windows["30d"].surfaces, []);
  });

  test("loadSubnetHealthTrends aggregates ranked-CTE rows into both windows", async () => {
    const data = await loadSubnetHealthTrends(
      d1({
        "FROM ranked": [
          {
            surface_id: "api-root",
            surface_key: "api-root",
            total: 100,
            ok_count: 95,
            latency_samples: 95,
            avg_latency_ms: 90,
            p50: 80,
            p95: 110,
            p99: 130,
          },
        ],
      }),
      NETUID,
      { observedAt: OBSERVED_AT },
    );
    for (const label of ["7d", "30d"]) {
      assert.equal(data.windows[label].surfaces[0].surface_id, "api-root");
      assert.equal(data.windows[label].surfaces[0].uptime_ratio, 0.95);
      assert.equal(data.windows[label].surfaces[0].latency_ms.p95, 110);
    }
  });

  test("loadSubnetPercentiles returns schema-stable empty surfaces on cold D1", async () => {
    const data = await loadSubnetPercentiles(d1(), NETUID, {
      window: "7d",
      observedAt: OBSERVED_AT,
    });
    assert.equal(data.netuid, NETUID);
    assert.equal(data.window, "7d");
    assert.equal(data.observed_at, OBSERVED_AT);
    assert.deepEqual(data.surfaces, []);
  });

  test("loadSubnetPercentiles shapes per-surface latency percentiles; unknown window → 7d", async () => {
    const data = await loadSubnetPercentiles(
      d1({
        "FROM ranked": [
          {
            surface_id: "api-root",
            surface_key: "api-root",
            latency_samples: 95,
            p50: 80,
            p95: 110,
            p99: 130,
            avg_latency_ms: 90,
            min_latency_ms: 40,
            max_latency_ms: 200,
          },
        ],
      }),
      NETUID,
      { window: "bogus", observedAt: OBSERVED_AT },
    );
    assert.equal(data.window, "7d"); // an unknown window defaults to 7d
    assert.equal(data.surfaces[0].surface_id, "api-root");
    assert.equal(data.surfaces[0].samples, 95);
    assert.equal(data.surfaces[0].latency_ms.p95, 110);
    assert.equal(data.surfaces[0].latency_ms.max, 200);
  });

  test("loadSubnetIncidents returns schema-stable empty surfaces on cold D1", async () => {
    const data = await loadSubnetIncidents(d1(), NETUID, {
      window: "7d",
      observedAt: OBSERVED_AT,
    });
    assert.equal(data.netuid, NETUID);
    assert.equal(data.window, "7d");
    assert.equal(data.observed_at, OBSERVED_AT);
    assert.deepEqual(data.surfaces, []);
  });

  test("loadSubnetIncidents joins SLA rows with gap-island incidents; unknown window → 7d", async () => {
    const data = await loadSubnetIncidents(
      d1({
        // The SLA rollup (samples + ok_count) and the gap-island incident scan are
        // two distinct reads against surface_checks; match each by a unique clause.
        "COUNT\\(\\*\\) AS total": [
          {
            surface_id: "api-root",
            surface_key: "api-root",
            total: 100,
            ok_count: 96,
          },
        ],
        "WITH checks AS": [
          {
            surface_id: "api-root",
            surface_key: "api-root",
            started_at: 1000,
            ended_at: 1300,
            failed_samples: 4,
          },
        ],
      }),
      NETUID,
      { window: "bogus", observedAt: OBSERVED_AT },
    );
    assert.equal(data.window, "7d"); // an unknown window defaults to 7d
    const surface = data.surfaces[0];
    assert.equal(surface.surface_id, "api-root");
    assert.equal(surface.samples, 100);
    assert.equal(surface.uptime_ratio, 0.96); // 96 / 100
    assert.equal(surface.incident_count, 1);
    assert.equal(surface.downtime_ms, 300); // 1300 - 1000
    assert.equal(surface.incidents[0].duration_ms, 300);
    assert.equal(surface.incidents[0].failed_samples, 4);
  });

  test("loadRegistryLeaderboards returns all boards object", async () => {
    const data = await loadRegistryLeaderboards(d1(), {
      profiles: [
        {
          netuid: 1,
          slug: "apex",
          name: "Apex",
          completeness_score: 80,
          surface_count: 5,
          operational_interface_count: 2,
        },
      ],
      economicsRows: [{ netuid: 1, open_slots: 2, emission_share: 0.1 }],
      observedAt: OBSERVED_AT,
    });
    assert.ok(typeof data.boards === "object");
    assert.ok(Object.keys(data.boards).length > 0);
  });

  test("loadRegistryLeaderboards can return a single requested board", async () => {
    const data = await loadRegistryLeaderboards(
      d1({
        "FROM surface_status": [
          {
            netuid: 1,
            total: 5,
            ok_count: 4,
            avg_latency_ms: 100,
          },
        ],
      }),
      {
        profiles: [
          {
            netuid: 1,
            slug: "apex",
            name: "Apex",
            completeness_score: 80,
            surface_count: 5,
            operational_interface_count: 2,
          },
        ],
        economicsRows: [{ netuid: 1, open_slots: 2, emission_share: 0.1 }],
        board: "healthiest",
        limit: 1,
        observedAt: OBSERVED_AT,
      },
    );
    assert.ok(data.boards.healthiest);
    assert.equal("fastest-rpc" in data.boards, false);
  });

  test("loadRegistryLeaderboards SQL averages only ok surface_status latencies", async () => {
    const surfaceStatusSql = [];
    await loadRegistryLeaderboards(
      async (sql) => {
        if (/FROM surface_status/.test(sql)) {
          surfaceStatusSql.push(sql);
          return [{ netuid: 1, total: 2, ok_count: 1, avg_latency_ms: 100 }];
        }
        return [];
      },
      { profiles: [], economicsRows: [], observedAt: OBSERVED_AT },
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

  test("loadCompareSubnets health SQL averages only ok surface_status latencies", async () => {
    let healthSql = "";
    await loadCompareSubnets(
      async (sql) => {
        if (/FROM surface_status/.test(sql)) {
          healthSql = sql;
          return [
            { netuid: 1, surface_count: 2, ok_count: 1, avg_latency_ms: 100 },
          ];
        }
        return [];
      },
      {
        profiles: [{ netuid: 1, slug: "a", name: "A" }],
        netuids: [1],
        dimensions: ["health"],
        observedAt: OBSERVED_AT,
      },
    );
    assert.match(healthSql, /status = 'ok'/);
    assert.match(healthSql, /ROUND\(AVG\(CASE WHEN/);
    assert.doesNotMatch(healthSql, /AVG\(latency_ms\)/);
  });

  test("loadRegistryLeaderboards ranks most-reliable from surface_uptime_daily", async () => {
    const data = await loadRegistryLeaderboards(
      d1({
        "FROM surface_uptime_daily": [
          {
            netuid: 7,
            samples: 100,
            ok_count: 100,
            avg_latency_ms: 50,
            latency_samples: 100,
          },
        ],
      }),
      {
        profiles: [{ netuid: 7, slug: "apex", name: "Apex" }],
        economicsRows: [],
        board: "most-reliable",
        limit: 5,
        observedAt: OBSERVED_AT,
      },
    );
    assert.equal(data.boards["most-reliable"].length, 1);
    assert.equal(data.boards["most-reliable"][0].netuid, 7);
    assert.equal(data.boards["most-reliable"][0].score, 100);
    assert.equal("healthiest" in data.boards, false);
  });

  test("loadCompareSubnets composes requested dimensions", async () => {
    const data = await loadCompareSubnets(
      d1({
        "FROM surface_status": [
          { netuid: 1, surface_count: 5, ok_count: 4, avg_latency_ms: 100 },
        ],
      }),
      {
        profiles: [{ netuid: 1, slug: "apex", name: "Apex" }],
        economicsRows: [],
        netuids: [1],
        dimensions: parseCompareDimensionList(["health"]),
        observedAt: OBSERVED_AT,
      },
    );
    assert.deepEqual(data.requested_netuids, [1]);
    assert.deepEqual(data.dimensions, ["health"]);
    assert.equal(data.subnets[0].health.ok_count, 4);
    assert.equal("structure" in data.subnets[0], false);
  });

  test("loadCompareSubnets includes structure and economics when requested", async () => {
    const data = await loadCompareSubnets(d1(), {
      profiles: [
        {
          netuid: 1,
          slug: "apex",
          name: "Apex",
          completeness_score: 80,
          surface_count: 5,
          operational_interface_count: 2,
        },
      ],
      economicsRows: [{ netuid: 1, open_slots: 2, emission_share: 0.1 }],
      netuids: [1],
      dimensions: ["structure", "economics"],
      observedAt: OBSERVED_AT,
    });
    assert.deepEqual(data.dimensions, ["structure", "economics"]);
    assert.equal(data.subnets[0].structure.completeness_score, 80);
    assert.equal(data.subnets[0].economics.open_slots, 2);
    assert.equal("health" in data.subnets[0], false);
  });

  test("loadCompareSubnets returns empty payload for missing netuids", async () => {
    const data = await loadCompareSubnets(d1(), {
      profiles: [],
      economicsRows: [],
      netuids: [],
      observedAt: OBSERVED_AT,
    });
    assert.deepEqual(data.requested_netuids, []);
    assert.deepEqual(data.subnets, []);
  });

  test("loadGlobalIncidents returns empty summary on cold D1", async () => {
    const data = await loadGlobalIncidents(d1(), {
      windowLabel: "7d",
      windowDays: 7,
      observedAt: OBSERVED_AT,
    });
    assert.equal(data.window, "7d");
    assert.equal(data.summary.incident_count, 0);
    assert.deepEqual(data.surfaces, []);
  });

  test("loadGlobalIncidents formats grouped incident rows", async () => {
    const now = Date.now();
    const data = await loadGlobalIncidents(
      d1({
        "FROM surface_checks": [
          {
            netuid: NETUID,
            surface_id: "api-root",
            surface_key: "api-root",
            started_at: now - 3_600_000,
            ended_at: now - 1_800_000,
            failed_samples: 4,
          },
        ],
      }),
      {
        windowLabel: "30d",
        windowDays: 30,
        observedAt: OBSERVED_AT,
      },
    );
    assert.equal(data.window, "30d");
    assert.equal(data.summary.incident_count, 1);
    assert.equal(data.surfaces[0].incidents[0].failed_samples, 4);
  });

  test("loadChainCalls aggregates grouped rows with an honest share denominator", async () => {
    const data = await loadChainCalls(
      d1({
        "GROUP BY call_module": [
          { call_module: "SubtensorModule", count: 60 },
          { call_module: "Balances", count: 30 },
        ],
        "COUNT\\(\\*\\) AS total": [{ total: 120 }],
      }),
      {
        window: "30d",
        groupBy: "module",
        limit: 2,
        observedAt: OBSERVED_AT,
        now: Date.UTC(2026, 5, 26),
      },
    );
    assert.equal(data.window, "30d");
    assert.equal(data.total_extrinsics, 120);
    assert.equal(data.call_count, 2);
    assert.equal(data.calls[0].share, 0.5);
  });

  test("loadChainCalls tie-breaks grouped rows for stable LIMIT membership", async () => {
    const captured = [];
    const run = async (sql, params) => {
      captured.push({ sql, params });
      if (/COUNT\(\*\) AS total/.test(sql)) return [{ total: 0 }];
      return [];
    };

    await loadChainCalls(run, {
      window: "7d",
      groupBy: "module",
      limit: 5,
      now: Date.UTC(2026, 5, 26),
    });
    assert.match(
      captured[0].sql,
      /GROUP BY call_module[\s\S]*ORDER BY count DESC, call_module ASC\s+LIMIT \?/,
    );

    captured.length = 0;
    await loadChainCalls(run, {
      window: "7d",
      groupBy: "module_function",
      limit: 5,
      now: Date.UTC(2026, 5, 26),
    });
    assert.match(
      captured[0].sql,
      /GROUP BY call_module, call_function[\s\S]*ORDER BY count DESC, call_module ASC, call_function ASC\s+LIMIT \?/,
    );
  });

  test("loadChainCalls groups by call_module and call_function when requested", async () => {
    const captured = [];
    const run = async (sql, params) => {
      captured.push({ sql, params });
      if (/call_function/.test(sql) && /GROUP BY/.test(sql)) {
        return [
          {
            call_module: "SubtensorModule",
            call_function: "add_stake",
            count: 10,
          },
        ];
      }
      if (/COUNT\(\*\) AS total/.test(sql)) return [{ total: 10 }];
      return [];
    };
    const data = await loadChainCalls(run, {
      window: "7d",
      groupBy: "module_function",
      limit: 5,
      observedAt: OBSERVED_AT,
      now: Date.UTC(2026, 5, 26),
    });
    assert.match(captured[0].sql, /call_module, call_function/);
    assert.equal(data.group_by, "module_function");
    assert.equal(data.calls[0].call_function, "add_stake");
  });

  test("loadChainCalls scopes grouped rows and totals by call_module", async () => {
    const captured = [];
    const run = async (sql, params) => {
      captured.push({ sql, params });
      if (/GROUP BY call_module, call_function/.test(sql)) {
        return [
          {
            call_module: "SubtensorModule",
            call_function: "add_stake",
            count: 50,
          },
        ];
      }
      if (/COUNT\(\*\) AS total/.test(sql)) return [{ total: 80 }];
      return [];
    };
    const data = await loadChainCalls(run, {
      window: "7d",
      groupBy: "module_function",
      callModule: "SubtensorModule",
      limit: 3,
      observedAt: OBSERVED_AT,
      now: Date.UTC(2026, 5, 26),
    });

    assert.match(captured[0].sql, /AND call_module = \?/);
    assert.match(captured[1].sql, /AND call_module = \?/);
    assert.deepEqual(captured[0].params.slice(1), ["SubtensorModule", 3]);
    assert.deepEqual(captured[1].params.slice(1), ["SubtensorModule"]);
    assert.equal(data.total_extrinsics, 80);
    assert.equal(data.calls[0].share, 0.625);
  });

  test("loadChainCalls falls back to 7d for an unknown window label", async () => {
    const data = await loadChainCalls(d1(), {
      window: "90d",
      observedAt: OBSERVED_AT,
    });
    assert.equal(data.window, "7d");
  });

  test("loadChainCalls returns a cold-stable empty payload", async () => {
    const data = await loadChainCalls(d1(), {
      window: "7d",
      observedAt: OBSERVED_AT,
    });
    assert.equal(data.call_count, 0);
    assert.deepEqual(data.calls, []);
  });
});

describe("loadChainFees", () => {
  test("aggregates daily series and top payers with call_module filter", async () => {
    const now = Date.UTC(2026, 5, 26);
    const dayMs = 24 * 60 * 60 * 1000;
    const calls = [];
    const run = async (sql, params) => {
      calls.push({ sql, params });
      if (/ROW_NUMBER\(\) OVER/.test(sql)) {
        return [
          {
            day: "2026-06-25",
            median_fee_tao: 0.5,
            median_tip_tao: 0.05,
          },
        ];
      }
      if (/GROUP BY day/.test(sql)) {
        return [
          {
            day: "2026-06-25",
            extrinsic_count: 10,
            total_fee_tao: 5,
            total_tip_tao: 1,
          },
        ];
      }
      return [
        {
          signer: "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
          total_fee_tao: 3,
          total_tip_tao: 0.5,
          extrinsic_count: 4,
        },
      ];
    };
    const { data, dailyRows, payerRows, medianRows } = await loadChainFees(
      run,
      {
        window: "7d",
        limit: 10,
        callModule: "SubtensorModule",
        observedAt: OBSERVED_AT,
        now,
      },
    );
    assert.equal(calls.length, 3);
    assert.equal(dailyRows.length, 1);
    assert.equal(payerRows.length, 1);
    assert.equal(medianRows.length, 1);
    assert.equal(data.window, "7d");
    assert.equal(data.day_count, 1);
    assert.equal(data.daily[0].extrinsic_count, 10);
    assert.equal(data.daily[0].median_fee_tao, 0.5);
    assert.equal(data.daily[0].median_tip_tao, 0.05);
    assert.equal(data.top_fee_payers[0].total_fee_tao, 3);
    assert.match(calls[0].sql, /call_module = \?/);
    assert.deepEqual(calls[0].params, [now - 7 * dayMs, "SubtensorModule"]);
    assert.match(calls[1].sql, /ORDER BY total_fee_tao DESC, signer ASC/);
    assert.deepEqual(calls[1].params, [now - 7 * dayMs, "SubtensorModule", 10]);
    assert.match(calls[2].sql, /ROW_NUMBER\(\) OVER/);
    assert.match(calls[2].sql, /INDEXED BY idx_extrinsics_module_observed/);
    assert.match(calls[2].sql, /PARTITION BY day ORDER BY fee_tao/);
    assert.match(calls[2].sql, /PARTITION BY day ORDER BY tip_tao/);
    assert.doesNotMatch(calls[2].sql, /GROUP BY day,\s*fee_tao,\s*tip_tao/);
    // The median query only scans days the daily aggregate above already
    // proved are within the sample cap (see the dedicated shape test below
    // for the multi-day / skip-the-over-cap-day case, and the honest-null
    // regression tests for what an over-cap day reports instead).
    assert.doesNotMatch(calls[2].sql, /ORDER BY RANDOM\(\)/);
    assert.doesNotMatch(calls[2].sql, /LIMIT/);
    // The call_module filter is the same value in every day block, so it's
    // bound ONCE (numbered ?1, reused across every UNION ALL block) rather
    // than re-bound per block.
    assert.match(calls[2].sql, /call_module = \?1/);
    const day25 = Date.UTC(2026, 5, 25);
    assert.deepEqual(calls[2].params, [
      "SubtensorModule",
      day25,
      day25 + dayMs,
    ]);
  });

  test("the median query includes one block per safe day and skips a day over the cap", async () => {
    const now = Date.UTC(2026, 5, 26);
    const dayMs = 24 * 60 * 60 * 1000;
    const calls = [];
    const safeDays = ["2026-06-23", "2026-06-24", "2026-06-25"];
    const run = async (sql, params) => {
      calls.push({ sql, params });
      if (/GROUP BY day/.test(sql)) {
        return [
          // Over the sample cap — must be excluded from the median query
          // entirely, not truncated to a subsample.
          {
            day: "2026-06-19",
            extrinsic_count: 50000,
            total_fee_tao: 1,
            total_tip_tao: 1,
          },
          ...safeDays.map((day) => ({
            day,
            extrinsic_count: 10,
            total_fee_tao: 1,
            total_tip_tao: 1,
          })),
        ];
      }
      return [];
    };
    await loadChainFees(run, { window: "7d", observedAt: OBSERVED_AT, now });
    const medianCall = calls.find((c) => /ROW_NUMBER\(\) OVER/.test(c.sql));
    assert.ok(medianCall, "median query must still run for the safe days");
    // 3 safe-day blocks => 2 UNION ALL joins; the over-cap day contributes none.
    assert.equal((medianCall.sql.match(/UNION ALL/g) || []).length, 2);
    assert.doesNotMatch(medianCall.sql, /ORDER BY RANDOM\(\)/);
    assert.doesNotMatch(medianCall.sql, /LIMIT/);
    const expectedParams = safeDays.flatMap((day) => {
      const start = Date.parse(`${day}T00:00:00.000Z`);
      return [start, start + dayMs];
    });
    assert.deepEqual(medianCall.params, expectedParams);
  });

  test("scoped median day blocks force the call_module observed_at index", () => {
    // Regression for scoped chain-fee medians: without a composite
    // call_module/observed_at path, SQLite can scan every row for the module
    // once per safe day and apply the day range as a residual filter.
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE extrinsics (
        block_number INTEGER NOT NULL, extrinsic_index INTEGER NOT NULL,
        observed_at INTEGER NOT NULL, fee_tao REAL, tip_tao REAL, call_module TEXT,
        PRIMARY KEY (block_number, extrinsic_index)
      );
      CREATE INDEX idx_extrinsics_observed ON extrinsics (observed_at);
      CREATE INDEX idx_extrinsics_module_block
        ON extrinsics (call_module, block_number DESC, extrinsic_index DESC);
      CREATE INDEX idx_extrinsics_module_observed
        ON extrinsics (call_module, observed_at);
    `);
    const dayStart = Date.UTC(2026, 5, 25);
    const dayMs = 24 * 60 * 60 * 1000;
    const sql = `SELECT strftime('%Y-%m-%d', observed_at / 1000, 'unixepoch') AS day,
                COALESCE(fee_tao, 0) AS fee_tao, COALESCE(tip_tao, 0) AS tip_tao
         FROM extrinsics INDEXED BY idx_extrinsics_module_observed
         WHERE observed_at >= ?2 AND observed_at < ?3 AND call_module = ?1`;
    const plan = db
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all("SubtensorModule", dayStart, dayStart + dayMs);
    assert.equal(plan.length, 1);
    assert.match(
      plan[0].detail,
      /SEARCH extrinsics USING INDEX idx_extrinsics_module_observed \(call_module=\? AND observed_at>\? AND observed_at<\?\)/,
    );
  });

  test("each included day's median block is an index-assisted range scan, not a full sort", () => {
    // Directly verifies the fix's core cost claim: the median query no
    // longer needs to scan or order every matching row for a day before a
    // cap applies — each included day's own range is index-terminated.
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE extrinsics (
        block_number INTEGER NOT NULL, extrinsic_index INTEGER NOT NULL,
        observed_at INTEGER NOT NULL, fee_tao REAL, tip_tao REAL, call_module TEXT,
        PRIMARY KEY (block_number, extrinsic_index)
      );
      CREATE INDEX idx_extrinsics_observed ON extrinsics (observed_at);
    `);
    const dayStart = Date.UTC(2026, 5, 25);
    const dayMs = 24 * 60 * 60 * 1000;
    const sql = `SELECT strftime('%Y-%m-%d', observed_at / 1000, 'unixepoch') AS day,
                COALESCE(fee_tao, 0) AS fee_tao, COALESCE(tip_tao, 0) AS tip_tao
         FROM extrinsics WHERE observed_at >= ? AND observed_at < ?`;
    const plan = db
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(dayStart, dayStart + dayMs);
    assert.equal(plan.length, 1);
    assert.match(
      plan[0].detail,
      /SEARCH extrinsics USING INDEX idx_extrinsics_observed/,
    );
    assert.equal(
      plan.some((p) => /TEMP B-TREE/.test(p.detail)),
      false,
    );
  });

  test("omits call_module from SQL params when unscoped", async () => {
    const now = Date.UTC(2026, 5, 26);
    const dayMs = 24 * 60 * 60 * 1000;
    const calls = [];
    const run = async (sql, params) => {
      calls.push({ sql, params });
      if (/GROUP BY day/.test(sql)) {
        return [
          {
            day: "2026-06-25",
            extrinsic_count: 10,
            total_fee_tao: 1,
            total_tip_tao: 1,
          },
        ];
      }
      return [];
    };
    await loadChainFees(run, {
      window: "30d",
      limit: 5,
      observedAt: OBSERVED_AT,
      now,
    });
    assert.equal(calls.length, 3);
    assert.doesNotMatch(calls[0].sql, /call_module = \?/);
    assert.deepEqual(calls[0].params, [now - 30 * dayMs]);
    assert.deepEqual(calls[1].params, [now - 30 * dayMs, 5]);
    assert.doesNotMatch(calls[2].sql, /call_module = \?/);
    assert.doesNotMatch(calls[2].sql, /LIMIT/);
    const day25 = Date.UTC(2026, 5, 25);
    assert.deepEqual(calls[2].params, [day25, day25 + dayMs]);
  });

  test("stays under D1's 100-bound-parameter limit when every day in a scoped 30d window is safe", async () => {
    // Regression: re-binding the call_module filter fresh per UNION ALL day
    // block (rather than once via a numbered ?1 param, reused across every
    // block) would push a scoped 30-day window towards 30 * 3 = 90+ params;
    // binding it once keeps real headroom under D1's 100-param limit.
    const now = Date.UTC(2026, 5, 26);
    const dayMs = 24 * 60 * 60 * 1000;
    const calls = [];
    const run = async (sql, params) => {
      calls.push({ sql, params });
      if (/GROUP BY day/.test(sql)) {
        const rows = [];
        for (let d = now - 30 * dayMs; d < now; d += dayMs) {
          rows.push({
            day: new Date(d).toISOString().slice(0, 10),
            extrinsic_count: 10,
            total_fee_tao: 1,
            total_tip_tao: 1,
          });
        }
        return rows;
      }
      return [];
    };
    await loadChainFees(run, {
      window: "30d",
      callModule: "SubtensorModule",
      observedAt: OBSERVED_AT,
      now,
    });
    const medianCall = calls.find((c) => /ROW_NUMBER\(\) OVER/.test(c.sql));
    assert.ok(medianCall);
    assert.ok(
      medianCall.params.length < 100,
      `median query has ${medianCall.params.length} bound params, over D1's 100-param limit`,
    );
  });

  test("treats empty call_module as unscoped", async () => {
    const now = Date.UTC(2026, 5, 26);
    const dayMs = 24 * 60 * 60 * 1000;
    const calls = [];
    await loadChainFees(
      async (sql, params) => {
        calls.push({ sql, params });
        if (/GROUP BY day/.test(sql)) {
          return [
            {
              day: "2026-06-25",
              extrinsic_count: 10,
              total_fee_tao: 1,
              total_tip_tao: 1,
            },
          ];
        }
        return [];
      },
      { window: "7d", callModule: "", observedAt: OBSERVED_AT, now },
    );
    assert.doesNotMatch(calls[0].sql, /call_module = \?/);
    assert.equal(calls[0].params.length, 1);
    assert.doesNotMatch(calls[2].sql, /call_module = \?/);
    assert.doesNotMatch(calls[2].sql, /LIMIT/);
    const day25 = Date.UTC(2026, 5, 25);
    assert.deepEqual(calls[2].params, [day25, day25 + dayMs]);
  });

  test("an over-cap day gets a null median without affecting a safe sibling day's exact median", async () => {
    // Regression for a global `LIMIT ?` applied ahead of the per-day
    // partition: once a single day exceeds the sample cap, days that sort
    // after it in scan order used to lose their entire sample. Now: an
    // over-cap day is excluded from the median query outright (honest
    // null), while a safe sibling day gets its exact, unsampled median
    // regardless of how much volume the over-cap day has.
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE extrinsics (
        block_number    INTEGER NOT NULL,
        extrinsic_index INTEGER NOT NULL,
        extrinsic_hash  TEXT,
        signer          TEXT,
        call_module     TEXT,
        call_function   TEXT,
        success         INTEGER,
        observed_at     INTEGER NOT NULL,
        fee_tao         REAL,
        tip_tao         REAL,
        PRIMARY KEY (block_number, extrinsic_index)
      );
      CREATE INDEX idx_extrinsics_observed ON extrinsics (observed_at);
    `);
    const insert = db.prepare(
      "INSERT INTO extrinsics (block_number, extrinsic_index, observed_at, fee_tao, tip_tao) VALUES (?, ?, ?, ?, ?)",
    );
    const dayMs = 24 * 60 * 60 * 1000;
    const day1Start = Date.UTC(2026, 5, 1);
    const day2Start = Date.UTC(2026, 5, 2);
    const day1Count = 10005; // exceeds CHAIN_FEE_MEDIAN_SAMPLE_LIMIT (10000)
    const day2Count = 10; // comfortably under the cap
    let block = 0;
    for (let i = 0; i < day1Count; i += 1) {
      insert.run(block, 0, day1Start + i, 1, 0.1);
      block += 1;
    }
    for (let i = 0; i < day2Count; i += 1) {
      insert.run(block, 0, day2Start + i, 2, 0.2);
      block += 1;
    }
    const run = async (sql, params) => db.prepare(sql).all(...params);
    const { data } = await loadChainFees(run, {
      window: "7d",
      observedAt: OBSERVED_AT,
      now: day2Start + day2Count + dayMs,
    });
    const byDay = Object.fromEntries(data.daily.map((d) => [d.day, d]));
    assert.ok(byDay["2026-06-01"], "the over-cap day must still report a day");
    assert.ok(
      byDay["2026-06-02"],
      "a sibling day must not be starved by day 1's volume",
    );
    assert.equal(
      byDay["2026-06-01"].median_fee_tao,
      null,
      "an over-cap day reports an honest null median, not an approximation",
    );
    assert.equal(byDay["2026-06-02"].median_fee_tao, 2);
    assert.equal(byDay["2026-06-02"].median_tip_tao, 0.2);
  });

  test("an over-cap day with a real intraday fee trend gets a null median instead of a biased guess", async () => {
    // Regression: any subsample of an over-cap day (chronological-first,
    // random, or bucketed) trades exactness for SOME bias — capping to the
    // chronologically-earliest rows silently pulled the median toward
    // however fees looked at the START of the day. Rather than pick a
    // "less wrong" sampling strategy, an over-cap day is excluded from the
    // median query outright, so its median is honestly null instead of
    // silently skewed toward part of the day's history.
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE extrinsics (
        block_number    INTEGER NOT NULL,
        extrinsic_index INTEGER NOT NULL,
        extrinsic_hash  TEXT,
        signer          TEXT,
        call_module     TEXT,
        call_function   TEXT,
        success         INTEGER,
        observed_at     INTEGER NOT NULL,
        fee_tao         REAL,
        tip_tao         REAL,
        PRIMARY KEY (block_number, extrinsic_index)
      );
      CREATE INDEX idx_extrinsics_observed ON extrinsics (observed_at);
    `);
    const insert = db.prepare(
      "INSERT INTO extrinsics (block_number, extrinsic_index, observed_at, fee_tao, tip_tao) VALUES (?, ?, ?, ?, ?)",
    );
    const dayMs = 24 * 60 * 60 * 1000;
    const dayStart = Date.UTC(2026, 5, 1);
    const lowFeeCount = 5000;
    const highFeeCount = 5100; // 10100 total, 100 over the cap
    let block = 0;
    for (let i = 0; i < lowFeeCount; i += 1) {
      insert.run(block, 0, dayStart + i, 0, 0);
      block += 1;
    }
    for (let i = 0; i < highFeeCount; i += 1) {
      insert.run(block, 0, dayStart + lowFeeCount + i, 1000, 100);
      block += 1;
    }
    const run = async (sql, params) => db.prepare(sql).all(...params);
    const { data } = await loadChainFees(run, {
      window: "7d",
      observedAt: OBSERVED_AT,
      now: dayStart + lowFeeCount + highFeeCount + dayMs,
    });
    const day = data.daily.find((d) => d.day === "2026-06-01");
    assert.ok(day, "the over-cap day must still report a day");
    assert.equal(day.extrinsic_count, lowFeeCount + highFeeCount);
    assert.equal(day.median_fee_tao, null);
    assert.equal(day.median_tip_tao, null);
  });

  test("loadChainFees tie-breaks top_fee_payers for stable LIMIT membership", async () => {
    const captured = [];
    const signerA = "5FHneW46xGXgs5mUive6eigkdRD2AYN6fy8616ckdp26RGGj";
    const signerB = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";
    const run = async (sql, params) => {
      captured.push({ sql, params });
      if (/ROW_NUMBER\(\) OVER/.test(sql)) return [];
      if (/GROUP BY day/.test(sql)) return [];
      if (/GROUP BY signer/.test(sql)) {
        // Simulate D1 honoring ORDER BY total_fee_tao DESC, signer ASC.
        const rows = [
          {
            signer: signerA,
            total_fee_tao: 5,
            total_tip_tao: 0,
            extrinsic_count: 2,
          },
          {
            signer: signerB,
            total_fee_tao: 5,
            total_tip_tao: 0,
            extrinsic_count: 3,
          },
        ];
        const lim = params[params.length - 1];
        return rows.slice(0, lim);
      }
      return [];
    };
    const { data } = await loadChainFees(run, {
      window: "7d",
      limit: 1,
      observedAt: OBSERVED_AT,
      now: Date.UTC(2026, 5, 26),
    });
    const payerSql = captured.find((c) => /GROUP BY signer/.test(c.sql));
    assert.match(
      payerSql.sql,
      /ORDER BY total_fee_tao DESC, signer ASC\s+LIMIT \?/,
    );
    assert.equal(data.top_fee_payers.length, 1);
    assert.equal(data.top_fee_payers[0].signer, signerA);
    assert.equal(data.top_fee_payers[0].total_fee_tao, 5);
  });

  test("falls back to 7d for an unknown window label", async () => {
    const { data } = await loadChainFees(d1(), {
      window: "90d",
      observedAt: OBSERVED_AT,
    });
    assert.equal(data.window, "7d");
  });

  test("returns a cold-stable empty payload", async () => {
    const { data } = await loadChainFees(d1(), {
      window: "30d",
      observedAt: OBSERVED_AT,
    });
    assert.equal(data.window, "30d");
    assert.equal(data.day_count, 0);
    assert.deepEqual(data.daily, []);
    assert.deepEqual(data.top_fee_payers, []);
  });
});

describe("loadNetworkActivity", () => {
  test("merges extrinsics + blocks tiers by UTC day", async () => {
    const now = Date.UTC(2026, 5, 26);
    const calls = [];
    const run = async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM extrinsics/.test(sql)) {
        return [
          {
            day: "2026-06-25",
            extrinsic_count: 100,
            successful_extrinsics: 99,
            unique_signers: 40,
          },
          {
            day: "2026-06-24",
            extrinsic_count: 50,
            successful_extrinsics: 50,
            unique_signers: 20,
          },
        ];
      }
      if (/FROM blocks/.test(sql)) {
        return [
          { day: "2026-06-25", block_count: 7200, event_count: 15000 },
          { day: "2026-06-24", block_count: 7100, event_count: 14000 },
        ];
      }
      return [];
    };
    const { data, extrinsicRows, blockRows } = await loadNetworkActivity(run, {
      window: "7d",
      observedAt: OBSERVED_AT,
      now,
    });
    assert.equal(calls.length, 2);
    assert.equal(extrinsicRows.length, 2);
    assert.equal(blockRows.length, 2);
    assert.equal(data.window, "7d");
    assert.equal(data.day_count, 2);
    assert.equal(data.days[0].day, "2026-06-25");
    assert.equal(data.days[0].success_rate, 0.99);
    assert.equal(data.days[0].block_count, 7200);
    assert.equal(data.days[0].unique_signers, 40);
    const ex = calls.find((q) => /FROM extrinsics/.test(q.sql));
    const bl = calls.find((q) => /FROM blocks/.test(q.sql));
    assert.match(ex.sql, /COUNT\(DISTINCT signer\)/);
    assert.match(bl.sql, /SUM\(event_count\)/);
    assert.deepEqual(ex.params, [now - 7 * 24 * 60 * 60 * 1000]);
    assert.deepEqual(bl.params, [now - 7 * 24 * 60 * 60 * 1000]);
  });

  test("uses a 30d cutoff when requested", async () => {
    const now = Date.UTC(2026, 5, 26);
    const cutoffs = [];
    await loadNetworkActivity(
      async (_sql, params) => {
        cutoffs.push(params[0]);
        return [];
      },
      { window: "30d", observedAt: OBSERVED_AT, now },
    );
    assert.equal(cutoffs.length, 2);
    assert.ok(cutoffs.every((c) => c === now - 30 * 24 * 60 * 60 * 1000));
  });

  test("falls back to 7d for an unknown window label", async () => {
    const { data } = await loadNetworkActivity(d1(), {
      window: "90d",
      observedAt: OBSERVED_AT,
    });
    assert.equal(data.window, "7d");
  });

  test("returns a cold-stable empty payload", async () => {
    const { data } = await loadNetworkActivity(d1(), {
      window: "30d",
      observedAt: OBSERVED_AT,
    });
    assert.equal(data.window, "30d");
    assert.equal(data.day_count, 0);
    assert.deepEqual(data.days, []);
  });
});

describe("analytics-live window parsers", () => {
  test("parseUptimeWindow accepts 90d and 1y only", () => {
    assert.equal(parseUptimeWindow(undefined), "90d");
    assert.equal(parseUptimeWindow("1y"), "1y");
    assert.equal(parseUptimeWindow("30d"), null);
  });

  test("parseAnalyticsWindow maps REST incident windows", () => {
    assert.deepEqual(parseAnalyticsWindow("30d"), { label: "30d", days: 30 });
    assert.equal(parseAnalyticsWindow("90d"), null);
  });

  test("parseCompareDimensionList rejects unknown dimensions", () => {
    assert.deepEqual(parseCompareDimensionList(["structure"]), ["structure"]);
    assert.equal(parseCompareDimensionList(["bogus"]), null);
    assert.deepEqual(parseCompareDimensionList(["structure", " health"]), [
      "structure",
      "health",
    ]);
    assert.equal(parseCompareDimensionList(["structure", ""]), null);
  });

  test("parseCompareDimensions mirrors REST comma-list input", () => {
    assert.deepEqual(parseCompareDimensions("structure,health"), [
      "structure",
      "health",
    ]);
    assert.deepEqual(parseCompareDimensions("structure, health"), [
      "structure",
      "health",
    ]);
    assert.deepEqual(parseCompareDimensions(null), [
      "structure",
      "economics",
      "health",
    ]);
    assert.equal(parseCompareDimensions("bogus"), null);
    assert.equal(parseCompareDimensions("structure,,health"), null);
  });
});
