import assert from "node:assert/strict";
import { describe, test } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { composeCompareData, handleRequest } from "../workers/api.mjs";
import { buildOpenApiArtifact } from "../src/contracts.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import { loadOpenApiComponentSchemas } from "../scripts/openapi-components.ts";

// composeCompareData is the pure projection at the heart of /api/v1/compare;
// these craft the resolved source rows directly so every found/missing/dimension
// branch is exercised without depending on built data artifacts.
describe("composeCompareData", () => {
  const subnetMeta = new Map([
    [1, { name: "Apex", slug: "apex" }],
    [2, { name: "Beta", slug: "beta" }],
  ]);

  test("composes all dimensions in requested order, null-safe per source tier", () => {
    const data = composeCompareData({
      requestedNetuids: [1, 2, 99999],
      dimensions: ["structure", "economics", "health"],
      subnetMeta,
      // subnet 1 has structure + health; subnet 2 has economics only.
      structureRows: [
        {
          netuid: 1,
          completeness_score: 80,
          surface_count: 5,
          operational_interface_count: 2,
        },
      ],
      economicsRows: [{ netuid: 2, registration_cost_tao: 1.5, open_slots: 3 }],
      healthRows: [
        { netuid: 1, surface_count: 5, ok_count: 4, avg_latency_ms: 120 },
      ],
      observedAt: "2026-06-24T00:00:00.000Z",
    });

    assert.equal(data.schema_version, 1);
    assert.equal(data.observed_at, "2026-06-24T00:00:00.000Z");
    assert.deepEqual(data.dimensions, ["structure", "economics", "health"]);
    assert.deepEqual(data.requested_netuids, [1, 2, 99999]);
    assert.deepEqual(
      data.subnets.map((s) => s.netuid),
      [1, 2, 99999],
    );

    const [s1, s2, s3] = data.subnets;
    // Found subnet present in structure + health, absent from economics.
    assert.equal(s1.found, true);
    assert.equal(s1.name, "Apex");
    assert.equal(s1.slug, "apex");
    assert.equal(s1.structure.completeness_score, 80);
    assert.equal(s1.economics, null);
    assert.equal(s1.health.ok_count, 4);
    // Found subnet present only in economics.
    assert.equal(s2.found, true);
    assert.equal(s2.structure, null);
    assert.equal(s2.economics.registration_cost_tao, 1.5);
    assert.equal(s2.health, null);
    // Unknown subnet: found:false, every dimension null, name/slug null.
    assert.equal(s3.found, false);
    assert.equal(s3.name, null);
    assert.equal(s3.slug, null);
    assert.equal(s3.structure, null);
    assert.equal(s3.economics, null);
    assert.equal(s3.health, null);
  });

  test("structure-only subset omits other keys and tolerates null source rows", () => {
    const data = composeCompareData({
      requestedNetuids: [1],
      dimensions: ["structure"],
      subnetMeta,
      structureRows: null,
      economicsRows: null,
      healthRows: null,
      observedAt: null,
    });
    assert.equal(data.observed_at, null);
    assert.deepEqual(data.dimensions, ["structure"]);
    const [s] = data.subnets;
    assert.equal(s.found, true);
    assert.equal("structure" in s, true);
    assert.equal(s.structure, null); // no structure row for this netuid
    assert.equal("economics" in s, false);
    assert.equal("health" in s, false);
  });

  test("economics-only subset composes just the economics tier", () => {
    const data = composeCompareData({
      requestedNetuids: [2],
      dimensions: ["economics"],
      subnetMeta,
      structureRows: [],
      economicsRows: [{ netuid: 2, open_slots: 3 }],
      healthRows: [],
      observedAt: null,
    });
    const [s] = data.subnets;
    assert.equal("structure" in s, false);
    assert.equal("health" in s, false);
    assert.equal(s.economics.open_slots, 3);
  });

  test("coerces string-typed D1 numeric cells to numbers across every tier", () => {
    // Some D1 read paths hand numeric columns back as strings; the compare
    // projection must not leak those as strings into the CompareArtifact
    // numeric fields. registration_allowed (a boolean) and absent/null cells
    // are left exactly as they arrive.
    const data = composeCompareData({
      requestedNetuids: [1, 2],
      dimensions: ["structure", "economics", "health"],
      subnetMeta,
      structureRows: [
        {
          netuid: 1,
          completeness_score: "80",
          surface_count: "5",
          operational_interface_count: "2",
        },
      ],
      economicsRows: [
        {
          netuid: 2,
          registration_cost_tao: "1.5",
          registration_allowed: true,
          open_slots: "3",
          emission_share: "0.12",
          alpha_price_tao: "0.04",
          validator_count: "8",
          miner_count: "64",
          total_stake_tao: "1200",
          miner_readiness: "72",
        },
      ],
      healthRows: [
        { netuid: 1, surface_count: "5", ok_count: "4", avg_latency_ms: "120" },
      ],
      observedAt: null,
    });

    const s1 = data.subnets.find((s) => s.netuid === 1);
    const s2 = data.subnets.find((s) => s.netuid === 2);
    assert.deepEqual(s1.structure, {
      completeness_score: 80,
      surface_count: 5,
      operational_interface_count: 2,
    });
    assert.deepEqual(s1.health, {
      surface_count: 5,
      ok_count: 4,
      avg_latency_ms: 120,
    });
    assert.deepEqual(s2.economics, {
      registration_cost_tao: 1.5,
      registration_allowed: true, // boolean preserved, not coerced
      open_slots: 3,
      emission_share: 0.12,
      alpha_price_tao: 0.04,
      validator_count: 8,
      miner_count: 64,
      total_stake_tao: 1200,
      miner_readiness: 72,
    });

    // A real number and a null cell pass through untouched.
    const passthrough = composeCompareData({
      requestedNetuids: [1],
      dimensions: ["structure"],
      subnetMeta,
      structureRows: [
        {
          netuid: 1,
          completeness_score: null,
          surface_count: 5,
          operational_interface_count: 2,
        },
      ],
      economicsRows: [],
      healthRows: [],
      observedAt: null,
    });
    assert.equal(passthrough.subnets[0].structure.completeness_score, null);
    assert.equal(passthrough.subnets[0].structure.surface_count, 5);

    // A blank or non-numeric string is left as-is rather than turned into 0/NaN.
    const oddCells = composeCompareData({
      requestedNetuids: [1],
      dimensions: ["health"],
      subnetMeta,
      structureRows: [],
      economicsRows: [],
      healthRows: [
        { netuid: 1, surface_count: "", ok_count: "n/a", avg_latency_ms: "9" },
      ],
      observedAt: null,
    });
    assert.equal(oddCells.subnets[0].health.surface_count, "");
    assert.equal(oddCells.subnets[0].health.ok_count, "n/a");
    assert.equal(oddCells.subnets[0].health.avg_latency_ms, 9);
  });

  test("attaches tiers whose D1 row netuid comes back as a string", () => {
    // The join key is the highest-risk string cell: requested netuids are
    // numbers, so a row keyed on the raw string "1"/"2" would miss the numeric
    // lookup and silently null out a populated tier. Every tier's key is
    // normalized through the same coercion the value fields use.
    const data = composeCompareData({
      requestedNetuids: [1, 2],
      dimensions: ["structure", "economics", "health"],
      subnetMeta,
      structureRows: [
        {
          netuid: "1",
          completeness_score: 80,
          surface_count: 5,
          operational_interface_count: 2,
        },
      ],
      economicsRows: [{ netuid: "2", open_slots: 3 }],
      healthRows: [
        { netuid: "1", surface_count: 5, ok_count: 4, avg_latency_ms: 120 },
      ],
      observedAt: null,
    });

    const s1 = data.subnets.find((s) => s.netuid === 1);
    const s2 = data.subnets.find((s) => s.netuid === 2);
    assert.equal(s1.structure.completeness_score, 80);
    assert.equal(s1.health.ok_count, 4);
    assert.equal(s2.economics.open_slots, 3);

    // A row with an unusable (non-integer) netuid is skipped in every tier,
    // not thrown on and not keyed under a junk value.
    const skipped = composeCompareData({
      requestedNetuids: [1],
      dimensions: ["structure", "economics", "health"],
      subnetMeta,
      structureRows: [
        { netuid: "nope", completeness_score: 1, surface_count: 1 },
        { netuid: null, completeness_score: 2, surface_count: 2 },
      ],
      economicsRows: [{ netuid: "x", open_slots: 3 }],
      healthRows: [{ netuid: null, ok_count: 4 }],
      observedAt: null,
    });
    assert.equal(skipped.subnets[0].structure, null);
    assert.equal(skipped.subnets[0].economics, null);
    assert.equal(skipped.subnets[0].health, null);
  });

  test("composeCompareData output validates against the CompareArtifact contract", async () => {
    const generatedAt = "2026-06-24T12:00:00.000Z";
    const openapi = buildOpenApiArtifact(
      generatedAt,
      await loadOpenApiComponentSchemas(generatedAt),
    );
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile({
      $id: "https://metagraph.sh/test/compare-artifact.json",
      components: openapi.components,
      $ref: "#/components/schemas/CompareArtifact",
    });

    const data = composeCompareData({
      requestedNetuids: [1, 2, 99999],
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
      economicsRows: [
        {
          netuid: 2,
          registration_cost_tao: 1.5,
          registration_allowed: true,
          open_slots: 3,
          emission_share: 0.12,
          alpha_price_tao: 0.04,
          validator_count: 8,
          miner_count: 64,
          total_stake_tao: 1200,
          miner_readiness: 72,
        },
      ],
      healthRows: [
        { netuid: 1, surface_count: 5, ok_count: 4, avg_latency_ms: 120 },
      ],
      observedAt: generatedAt,
    });

    assert.equal(validate(data), true, ajv.errorsText(validate.errors));

    const structureOnly = composeCompareData({
      requestedNetuids: [1],
      dimensions: ["structure"],
      subnetMeta: new Map([[1, { name: "Apex", slug: "apex" }]]),
      structureRows: [],
      economicsRows: [],
      healthRows: [],
      observedAt: null,
    });
    assert.equal(
      validate(structureOnly),
      true,
      ajv.errorsText(validate.errors),
    );
  });
});

describe("GET /api/v1/compare", () => {
  const env = createLocalArtifactEnv();
  const get = async (path) => {
    const res = await handleRequest(
      new Request(`https://api.metagraph.sh${path}`),
      env,
      {},
    );
    return { status: res.status, body: await res.json() };
  };

  test("returns one entry per requested netuid in order, all dimensions by default", async () => {
    const { status, body } = await get("/api/v1/compare?netuids=1,7,64");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(body.data.requested_netuids, [1, 7, 64]);
    assert.deepEqual(
      body.data.subnets.map((s) => s.netuid),
      [1, 7, 64],
    );
    assert.deepEqual(body.data.dimensions, [
      "structure",
      "economics",
      "health",
    ]);
    for (const s of body.data.subnets) {
      assert.equal("structure" in s, true);
      assert.equal("economics" in s, true);
      assert.equal("health" in s, true);
    }
    assert.equal(body.meta.artifact_path, "/metagraph/compare.json");
  });

  test("dimensions subset restricts the composed domains", async () => {
    const { body } = await get(
      "/api/v1/compare?netuids=1&dimensions=economics",
    );
    assert.deepEqual(body.data.dimensions, ["economics"]);
    const [s] = body.data.subnets;
    assert.equal("economics" in s, true);
    assert.equal("structure" in s, false);
    assert.equal("health" in s, false);
  });

  test("dimensions are echoed in canonical order regardless of request order", async () => {
    const { body } = await get(
      "/api/v1/compare?netuids=1&dimensions=health,structure",
    );
    assert.deepEqual(body.data.dimensions, ["structure", "health"]);
  });

  test("dimensions tolerate whitespace around comma-separated entries", async () => {
    const { body } = await get(
      "/api/v1/compare?netuids=1&dimensions=structure,%20health",
    );
    assert.deepEqual(body.data.dimensions, ["structure", "health"]);
    const [s] = body.data.subnets;
    assert.equal("structure" in s, true);
    assert.equal("health" in s, true);
  });

  test("rejects empty dimension tokens", async () => {
    const { status, body } = await get(
      "/api/v1/compare?netuids=1&dimensions=structure,,health",
    );
    assert.equal(status, 400);
    assert.equal(body.meta.parameter, "dimensions");
  });

  test("an unknown netuid is found:false, never a 404", async () => {
    const { status, body } = await get("/api/v1/compare?netuids=99999");
    assert.equal(status, 200);
    assert.equal(body.data.subnets[0].netuid, 99999);
    assert.equal(body.data.subnets[0].found, false);
  });

  test("duplicate netuids are de-duplicated, preserving first position", async () => {
    const { body } = await get("/api/v1/compare?netuids=7,7,1");
    assert.deepEqual(body.data.requested_netuids, [7, 1]);
  });

  test("rejects malformed, missing, and unsupported query params", async () => {
    const cases = [
      ["/api/v1/compare", "netuids"],
      ["/api/v1/compare?netuids=", "netuids"],
      ["/api/v1/compare?netuids=1,abc", "netuids"],
      ["/api/v1/compare?dimensions=structure", "netuids"],
      ["/api/v1/compare?netuids=1&dimensions=bogus", "dimensions"],
      ["/api/v1/compare?netuids=1&x=1", "x"],
      ["/api/v1/compare?netuids=1&netuids=2", "netuids"],
    ];
    for (const [path, parameter] of cases) {
      const { status, body } = await get(path);
      assert.equal(status, 400, path);
      assert.equal(body.error.code, "invalid_query", path);
      assert.equal(body.meta.parameter, parameter, path);
    }
  });

  test("rejects more than 128 netuids", async () => {
    const many = Array.from({ length: 129 }, (_, i) => i + 1).join(",");
    const { status, body } = await get(`/api/v1/compare?netuids=${many}`);
    assert.equal(status, 400);
    assert.equal(body.meta.parameter, "netuids");
  });

  // D1 fully eliminated (2026-07-17): the health dimension's Postgres tier
  // (METAGRAPH_HEALTH_SOURCE) is the only source for these rows now -- a tier
  // miss falls straight through to an empty health row (never a live D1
  // query). These tests exercise the full GET /api/v1/compare request path
  // (through handleRequest, not handleCompare directly) to prove observed_at
  // stamping and netuid threading into the synthesized internal
  // compare-health request still work end to end.
  test("stamps observed_at from the live cron snapshot and threads netuids to the health tier", async () => {
    const requests = [];
    const healthEnv = {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_SOURCE: "postgres",
      DATA_API: {
        fetch: async (request) => {
          requests.push(request.url);
          return Response.json({
            rows: [
              { netuid: 7, surface_count: 3, ok_count: 2, avg_latency_ms: 150 },
            ],
          });
        },
      },
      METAGRAPH_CONTROL: {
        async get(key) {
          return key === "health:meta"
            ? { last_run_at: "2026-06-24T01:02:03.000Z" }
            : null;
        },
      },
    };
    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/compare?netuids=7&dimensions=health",
        {},
      ),
      healthEnv,
      {},
    );
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.data.observed_at, "2026-06-24T01:02:03.000Z");
    assert.deepEqual(body.data.dimensions, ["health"]);
    assert.equal(body.data.subnets[0].netuid, 7);
    assert.equal(body.data.subnets[0].health.ok_count, 2);
    assert.equal(requests.length, 1);
    assert.match(requests[0], /\/api\/v1\/internal\/compare-health\?/);
    assert.match(requests[0], /netuids=7(?:$|&)/);
  });

  test("health tier request is constrained to de-duplicated requested netuids", async () => {
    const requests = [];
    const healthEnv = {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_SOURCE: "postgres",
      DATA_API: {
        fetch: async (request) => {
          requests.push(request.url);
          return Response.json({ rows: [] });
        },
      },
    };
    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/compare?netuids=7,7,1&dimensions=health,structure",
        {},
      ),
      healthEnv,
      {},
    );
    assert.equal(res.status, 200);
    assert.equal(requests.length, 1);
    assert.match(requests[0], /netuids=7,1(?:$|&)/);
  });
});

// #6325: exercises the actual workers/api.mjs dispatch (uncached, unlike
// /api/v1/compare above) rather than calling handleCompareValidators
// directly, so the route-matching branch itself is covered too.
describe("GET /api/v1/compare/validators", () => {
  const env = createLocalArtifactEnv();
  const get = async (path) => {
    const res = await handleRequest(
      new Request(`https://api.metagraph.sh${path}`),
      env,
      {},
    );
    return { status: res.status, body: await res.json() };
  };
  const HOTKEY_A = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";
  const HOTKEY_B = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

  test("returns one entry per requested hotkey in order, zeroed on cold store", async () => {
    const { status, body } = await get(
      `/api/v1/compare/validators?hotkeys=${HOTKEY_A},${HOTKEY_B}`,
    );
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data.netuid, null);
    assert.deepEqual(
      body.data.validators.map((v) => v.hotkey),
      [HOTKEY_A, HOTKEY_B],
    );
    assert.equal(body.meta.artifact_path, "/metagraph/compare/validators.json");
  });

  test("requires hotkeys", async () => {
    const { status, body } = await get("/api/v1/compare/validators");
    assert.equal(status, 400);
    assert.equal(body.meta.parameter, "hotkeys");
  });

  test("rejects a malformed netuid", async () => {
    const { status, body } = await get(
      `/api/v1/compare/validators?hotkeys=${HOTKEY_A}&netuid=bogus`,
    );
    assert.equal(status, 400);
    assert.equal(body.meta.parameter, "netuid");
  });
});
