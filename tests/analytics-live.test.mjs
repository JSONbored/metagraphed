import assert from "node:assert/strict";
import { describe, test } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  composeCompareData,
  growthRowsFromSamples,
  loadCompareSubnets,
  loadGlobalIncidents,
  loadRegistryLeaderboards,
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
