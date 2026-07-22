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
} from "../src/analytics-live.ts";
import { buildOpenApiArtifact } from "../src/contracts.mjs";
import { loadOpenApiComponentSchemas } from "../scripts/openapi-components.mjs";

const NETUID = 7;
const OBSERVED_AT = "2026-06-24T12:00:00.000Z";

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

  test("growthRowsFromSamples emits an integer netuid; drops blank/null/non-numeric", () => {
    // D1 hands the INTEGER netuid back as the string "5"; the emitted netuid keys
    // the integer-keyed subnetMeta map in formatLeaderboards, so it must be an
    // integer. Blank/null/non-numeric cells are dropped, never read as subnet 0.
    const rows = growthRowsFromSamples([
      { netuid: "5", completeness_score: 20 },
      { netuid: "5", completeness_score: 50 },
      { netuid: "", completeness_score: 9 }, // blank → dropped (not subnet 0)
      { netuid: null, completeness_score: 9 }, // dropped
      { netuid: false, completeness_score: 9 }, // dropped
      { netuid: "abc", completeness_score: 9 }, // non-numeric → dropped
      { netuid: -1, completeness_score: 9 }, // negative → dropped
    ]);
    assert.deepEqual(rows, [{ netuid: 5, delta: 30 }]);
    assert.equal(typeof rows[0].netuid, "number");
  });
});

describe("analytics-live loaders", () => {
  // D1 fully eliminated (2026-07-17): every loader below is only ever reached
  // on a Postgres-tier miss, so each always returns its schema-stable empty
  // shape now — there are no more D1 rows to aggregate/shape.

  test("loadSubnetUptime returns schema-stable empty surfaces (D1 retired)", async () => {
    const data = await loadSubnetUptime(NETUID, {
      window: "90d",
      observedAt: OBSERVED_AT,
    });
    assert.equal(data.netuid, NETUID);
    assert.equal(data.window, "90d");
    assert.deepEqual(data.surfaces, []);
  });

  test("loadSubnetHealthTrends returns schema-stable empty surfaces (D1 retired)", async () => {
    const data = await loadSubnetHealthTrends(NETUID, {
      observedAt: OBSERVED_AT,
    });
    assert.equal(data.netuid, NETUID);
    assert.equal(data.observed_at, OBSERVED_AT);
    assert.deepEqual(data.windows["7d"].surfaces, []);
    assert.deepEqual(data.windows["30d"].surfaces, []);
  });

  test("loadSubnetPercentiles returns schema-stable empty surfaces; unknown window falls back to 7d", async () => {
    const data = await loadSubnetPercentiles(NETUID, {
      window: "bogus",
      observedAt: OBSERVED_AT,
    });
    assert.equal(data.netuid, NETUID);
    assert.equal(data.window, "7d"); // an unknown window defaults to 7d
    assert.equal(data.observed_at, OBSERVED_AT);
    assert.deepEqual(data.surfaces, []);
  });

  test("loadSubnetIncidents returns schema-stable empty surfaces; unknown window falls back to 7d", async () => {
    const data = await loadSubnetIncidents(NETUID, {
      window: "bogus",
      observedAt: OBSERVED_AT,
    });
    assert.equal(data.netuid, NETUID);
    assert.equal(data.window, "7d"); // an unknown window defaults to 7d
    assert.equal(data.observed_at, OBSERVED_AT);
    assert.deepEqual(data.surfaces, []);
  });

  test("loadRegistryLeaderboards keeps D1 boards empty; registry/economics boards still populate", async () => {
    const data = await loadRegistryLeaderboards({
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
    // surface_status/surface_uptime_daily-backed boards are always empty now.
    assert.deepEqual(data.boards.healthiest, []);
    assert.deepEqual(data.boards["fastest-rpc"], []);
    assert.deepEqual(data.boards["fastest-growing"], []);
    assert.deepEqual(data.boards["most-reliable"], []);
    // profiles/economicsRows aren't D1 -- those boards still populate.
    assert.ok(data.boards["most-complete"].length > 0);
    assert.ok(data.boards["open-slots"].length > 0);
  });

  test("loadRegistryLeaderboards can return a single requested board", async () => {
    const data = await loadRegistryLeaderboards({
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
    });
    assert.deepEqual(data.boards.healthiest, []);
    assert.equal("fastest-rpc" in data.boards, false);
  });

  test("loadCompareSubnets health dimension is always empty (D1 retired)", async () => {
    const data = await loadCompareSubnets({
      profiles: [{ netuid: 1, slug: "apex", name: "Apex" }],
      economicsRows: [],
      netuids: [1],
      dimensions: parseCompareDimensionList(["health"]),
      observedAt: OBSERVED_AT,
    });
    assert.deepEqual(data.requested_netuids, [1]);
    assert.deepEqual(data.dimensions, ["health"]);
    assert.equal(data.subnets[0].health, null);
    assert.equal("structure" in data.subnets[0], false);
  });

  test("loadCompareSubnets includes structure and economics when requested", async () => {
    const data = await loadCompareSubnets({
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
    const data = await loadCompareSubnets({
      profiles: [],
      economicsRows: [],
      netuids: [],
      observedAt: OBSERVED_AT,
    });
    assert.deepEqual(data.requested_netuids, []);
    assert.deepEqual(data.subnets, []);
  });

  test("loadGlobalIncidents returns empty summary (D1 retired)", async () => {
    const data = await loadGlobalIncidents({
      windowLabel: "7d",
      observedAt: OBSERVED_AT,
    });
    assert.equal(data.window, "7d");
    assert.equal(data.summary.incident_count, 0);
    assert.deepEqual(data.surfaces, []);
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
