import assert from "node:assert/strict";
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
    const calls = [];
    const run = async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes("strftime")) {
        return [
          {
            day: "2026-06-01",
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
    const { data, dailyRows, payerRows } = await loadChainFees(run, {
      window: "7d",
      limit: 10,
      callModule: "SubtensorModule",
      observedAt: OBSERVED_AT,
      now,
    });
    assert.equal(calls.length, 2);
    assert.equal(dailyRows.length, 1);
    assert.equal(payerRows.length, 1);
    assert.equal(data.window, "7d");
    assert.equal(data.day_count, 1);
    assert.equal(data.daily[0].extrinsic_count, 10);
    assert.equal(data.top_fee_payers[0].total_fee_tao, 3);
    assert.match(calls[0].sql, /call_module = \?/);
    assert.deepEqual(calls[0].params, [
      now - 7 * 24 * 60 * 60 * 1000,
      "SubtensorModule",
    ]);
    assert.match(calls[1].sql, /ORDER BY total_fee_tao DESC/);
    assert.deepEqual(calls[1].params, [
      now - 7 * 24 * 60 * 60 * 1000,
      "SubtensorModule",
      10,
    ]);
  });

  test("omits call_module from SQL params when unscoped", async () => {
    const now = Date.UTC(2026, 5, 26);
    const calls = [];
    const run = async (sql, params) => {
      calls.push({ sql, params });
      return [];
    };
    await loadChainFees(run, {
      window: "30d",
      limit: 5,
      observedAt: OBSERVED_AT,
      now,
    });
    assert.equal(calls.length, 2);
    assert.doesNotMatch(calls[0].sql, /call_module = \?/);
    assert.deepEqual(calls[0].params, [now - 30 * 24 * 60 * 60 * 1000]);
    assert.deepEqual(calls[1].params, [now - 30 * 24 * 60 * 60 * 1000, 5]);
  });

  test("treats empty call_module as unscoped", async () => {
    const calls = [];
    await loadChainFees(
      async (sql, params) => {
        calls.push({ sql, params });
        return [];
      },
      { window: "7d", callModule: "", observedAt: OBSERVED_AT },
    );
    assert.doesNotMatch(calls[0].sql, /call_module = \?/);
    assert.equal(calls[0].params.length, 1);
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
  });

  test("parseCompareDimensions mirrors REST comma-list input", () => {
    assert.deepEqual(parseCompareDimensions("structure,health"), [
      "structure",
      "health",
    ]);
    assert.deepEqual(parseCompareDimensions(null), [
      "structure",
      "economics",
      "health",
    ]);
    assert.equal(parseCompareDimensions("bogus"), null);
  });
});
