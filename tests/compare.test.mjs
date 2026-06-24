import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { composeCompareData, handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";

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

  test("stamps observed_at from the live cron snapshot and reads the health tier from D1", async () => {
    const queries = [];
    const healthEnv = {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind(...params) {
              queries.push({ sql, params });
              return {
                all: () =>
                  Promise.resolve({
                    results: [
                      {
                        netuid: 7,
                        surface_count: 3,
                        ok_count: 2,
                        avg_latency_ms: 150,
                      },
                    ],
                  }),
              };
            },
          };
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
    assert.match(queries[0].sql, /WHERE netuid IN \(\?\)/);
    assert.deepEqual(queries[0].params, [7]);
  });

  test("health D1 aggregation is constrained to de-duplicated requested netuids", async () => {
    const queries = [];
    const healthEnv = {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind(...params) {
              queries.push({ sql, params });
              return {
                all: () => Promise.resolve({ results: [] }),
              };
            },
          };
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
    assert.equal(queries.length, 1);
    assert.match(queries[0].sql, /WHERE netuid IN \(\?, \?\)/);
    assert.deepEqual(queries[0].params, [7, 1]);
  });
});
