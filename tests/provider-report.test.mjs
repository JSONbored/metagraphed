import assert from "node:assert/strict";
import { describe, test } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { buildOpenApiArtifact, CONTRACT_VERSION } from "../src/contracts.mjs";
import {
  composeProviderReport,
  parseProviderReportDimensions,
  PROVIDER_REPORT_DIMENSIONS,
} from "../src/provider-report.mjs";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";
import { loadOpenApiComponentSchemas } from "../scripts/openapi-components.mjs";
import {
  canonicalProviderReportCachePath,
  handleProviderReport,
} from "../workers/request-handlers/provider-report.mjs";

const OBSERVED_AT = "2026-06-28T12:00:00.000Z";

const sampleProvider = {
  id: "datura",
  name: "Datura",
  kind: "infrastructure-provider",
  website_url: "https://datura.ai",
  authority: "community",
  netuids: [1, 7],
  subnet_count: 2,
  surface_count: 4,
  endpoint_count: 2,
};

function d1Env(rowsBySql = {}) {
  return {
    METAGRAPH_HEALTH_DB: {
      prepare(sql) {
        return {
          bind(..._params) {
            return {
              async all() {
                for (const [pattern, rows] of Object.entries(rowsBySql)) {
                  if (new RegExp(pattern).test(sql)) {
                    return { results: rows };
                  }
                }
                return { results: [] };
              },
            };
          },
        };
      },
    },
  };
}

function req(path) {
  return new Request(`https://api.metagraph.sh${path}`);
}

function url(path) {
  return new URL(`https://api.metagraph.sh${path}`);
}

describe("provider-report composition", () => {
  test("parseProviderReportDimensions defaults and validates", () => {
    assert.deepEqual(
      parseProviderReportDimensions(null),
      PROVIDER_REPORT_DIMENSIONS,
    );
    assert.deepEqual(parseProviderReportDimensions("health,surfaces"), [
      "surfaces",
      "health",
    ]);
    assert.equal(parseProviderReportDimensions("bogus").error, "bogus");
  });

  test("composeProviderReport maps identity, surfaces, health, and economics", () => {
    const data = composeProviderReport({
      providerSlug: "datura",
      provider: sampleProvider,
      dimensions: ["identity", "surfaces", "health", "economics"],
      netuids: [1, 7],
      subnetMeta: new Map([
        [1, { name: "Apex", slug: "apex" }],
        [7, { name: "Subvortex", slug: "subvortex" }],
      ]),
      economicsRows: [
        {
          netuid: 1,
          registration_allowed: true,
          validator_count: 8,
          miner_count: 64,
        },
      ],
      healthRows: [
        { netuid: 1, surface_count: 2, ok_count: 2, avg_latency_ms: 40 },
        { netuid: 7, surface_count: 2, ok_count: 1, avg_latency_ms: 90 },
      ],
      surfaceKindRows: [
        {
          netuid: 1,
          kind: "subnet-api",
          count: 1,
          ok_count: 1,
          avg_latency_ms: 35,
        },
        {
          netuid: 1,
          kind: "openapi",
          count: 1,
          ok_count: 1,
          avg_latency_ms: 45,
        },
        {
          netuid: 7,
          kind: "subnet-api",
          count: 2,
          ok_count: 1,
          avg_latency_ms: 90,
        },
      ],
      observedAt: OBSERVED_AT,
    });

    assert.equal(data.found, true);
    assert.equal(data.identity.name, "Datura");
    assert.equal(data.subnets.length, 2);
    assert.equal(data.subnets[0].surfaces.count, 2);
    assert.equal(data.subnets[0].surfaces.kinds["subnet-api"].ok_count, 1);
    assert.equal(data.subnets[0].health.ok_count, 2);
    assert.equal(data.subnets[0].economics.validator_count, 8);
    assert.equal(data.subnets[1].economics, null);
    assert.equal(data.totals.surface_count, 4);
    assert.equal(data.totals.health_ok_ratio, 0.75);
  });

  test("parseProviderReportDimensions rejects empty dimension tokens", () => {
    assert.equal(parseProviderReportDimensions("").error, "");
  });

  test("composeProviderReport applies nullable field fallbacks on sparse rows", () => {
    const data = composeProviderReport({
      providerSlug: "datura",
      provider: { id: "datura" },
      dimensions: ["economics", "health", "surfaces"],
      netuids: [1],
      subnetMeta: new Map([[1, { name: "Apex", slug: "apex" }]]),
      economicsRows: [{ netuid: 1 }],
      healthRows: [{ netuid: 1 }],
      surfaceKindRows: [{ netuid: 1, kind: "openapi" }],
      observedAt: OBSERVED_AT,
    });
    assert.equal(data.subnets[0].economics.registration_allowed, false);
    assert.equal(data.subnets[0].economics.validator_count, 0);
    assert.equal(data.subnets[0].health.surface_count, 0);
    assert.equal(data.subnets[0].surfaces.kinds.openapi.count, 0);
    assert.equal(data.totals.surface_count, 0);
  });

  test("composeProviderReport nulls health and economics when subnet meta is missing", () => {
    const data = composeProviderReport({
      providerSlug: "datura",
      provider: sampleProvider,
      dimensions: ["health", "economics"],
      netuids: [1],
      subnetMeta: new Map(),
      economicsRows: [{ netuid: 1, validator_count: 2 }],
      healthRows: [{ netuid: 1, surface_count: 1, ok_count: 1 }],
      surfaceKindRows: [],
      observedAt: OBSERVED_AT,
    });
    assert.equal(data.subnets[0].found, false);
    assert.equal(data.subnets[0].health, null);
    assert.equal(data.subnets[0].economics, null);
  });

  test("composeProviderReport nulls per-subnet health and economics when rows are absent", () => {
    const data = composeProviderReport({
      providerSlug: "datura",
      provider: sampleProvider,
      dimensions: ["health", "economics"],
      netuids: [1],
      subnetMeta: new Map([[1, { name: "Apex", slug: "apex" }]]),
      economicsRows: [],
      healthRows: [],
      surfaceKindRows: [],
      observedAt: OBSERVED_AT,
    });
    assert.equal(data.subnets[0].found, true);
    assert.equal(data.subnets[0].health, null);
    assert.equal(data.subnets[0].economics, null);
  });

  test("composeProviderReport omits unrequested dimensions and nulls missing tiers", () => {
    const data = composeProviderReport({
      providerSlug: "datura",
      provider: { id: "datura" },
      dimensions: ["identity"],
      netuids: [1, 999],
      subnetMeta: new Map([[1, { name: "Apex", slug: "apex" }]]),
      economicsRows: [{ netuid: 1, validator_count: 3, miner_count: 1 }],
      healthRows: [{ netuid: 1, surface_count: 2, ok_count: 1 }],
      surfaceKindRows: [
        {
          netuid: 1,
          kind: "openapi",
          count: 2,
          ok_count: 1,
          avg_latency_ms: 5,
        },
      ],
      observedAt: null,
    });
    assert.equal(data.observed_at, null);
    assert.equal(data.identity.subnet_count, 2);
    assert.equal(data.identity.surface_count, 2);
    assert.equal(data.identity.endpoint_count, 0);
    assert.equal(data.subnets[0].found, true);
    assert.equal("surfaces" in data.subnets[0], false);
    assert.equal("health" in data.subnets[0], false);
    assert.equal("economics" in data.subnets[0], false);
    assert.equal(data.subnets[1].found, false);
    assert.equal(data.totals.health_ok_ratio, 0.5);
  });

  test("composeProviderReport nulls surfaces and health_ok_ratio on empty health", () => {
    const data = composeProviderReport({
      providerSlug: "datura",
      provider: null,
      dimensions: ["surfaces", "health"],
      netuids: [1],
      subnetMeta: new Map([[1, { name: "Apex", slug: "apex" }]]),
      economicsRows: [],
      healthRows: [],
      surfaceKindRows: [],
      observedAt: OBSERVED_AT,
    });
    assert.equal(data.found, false);
    assert.equal(data.identity, null);
    assert.equal(data.subnets[0].surfaces, null);
    assert.equal(data.subnets[0].health, null);
    assert.equal(data.totals.health_ok_ratio, null);
    assert.equal(data.totals.surface_count, 0);
  });

  test("composeProviderReport maps full economics and health field fallbacks", () => {
    const data = composeProviderReport({
      providerSlug: "datura",
      provider: sampleProvider,
      dimensions: ["economics", "health", "surfaces"],
      netuids: [1],
      subnetMeta: new Map([[1, { name: "Apex", slug: "apex" }]]),
      economicsRows: [
        {
          netuid: 1,
          registration_cost_tao: 0.5,
          registration_allowed: true,
          open_slots: 3,
          emission_share: 0.1,
          alpha_price_tao: 0.02,
          validator_count: 4,
          miner_count: 8,
          total_stake_tao: 1000,
          miner_readiness: 0.8,
        },
      ],
      healthRows: [
        { netuid: 1, surface_count: 1, ok_count: 1, avg_latency_ms: 12 },
      ],
      surfaceKindRows: [
        {
          netuid: 1,
          kind: "openapi",
          count: 1,
          ok_count: 1,
          avg_latency_ms: 12,
        },
      ],
      observedAt: OBSERVED_AT,
    });
    assert.equal(data.subnets[0].economics.total_stake_tao, 1000);
    assert.equal(data.subnets[0].health.avg_latency_ms, 12);
    assert.equal(data.subnets[0].surfaces.kinds.openapi.count, 1);
  });

  test("composeProviderReport validates against ProviderReportArtifact", async () => {
    const generatedAt = OBSERVED_AT;
    const openapi = buildOpenApiArtifact(
      generatedAt,
      await loadOpenApiComponentSchemas(generatedAt),
    );
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile({
      $id: "https://metagraph.sh/test/provider-report-artifact.json",
      components: openapi.components,
      $ref: "#/components/schemas/ProviderReportArtifact",
    });
    const data = composeProviderReport({
      providerSlug: "datura",
      provider: sampleProvider,
      dimensions: PROVIDER_REPORT_DIMENSIONS,
      netuids: [1],
      subnetMeta: new Map([[1, { name: "Apex", slug: "apex" }]]),
      economicsRows: [],
      healthRows: [
        { netuid: 1, surface_count: 1, ok_count: 1, avg_latency_ms: 10 },
      ],
      surfaceKindRows: [
        {
          netuid: 1,
          kind: "openapi",
          count: 1,
          ok_count: 1,
          avg_latency_ms: 10,
        },
      ],
      observedAt: generatedAt,
    });
    assert.equal(validate(data), true, ajv.errorsText(validate.errors));
  });
});

function archiveEnv(filesByKey = {}) {
  return {
    METAGRAPH_ARCHIVE: {
      async get(key) {
        const relative = String(key).replace(/^latest\//, "");
        const body = filesByKey[relative];
        if (body === undefined) return null;
        return {
          async json() {
            return typeof body === "string" ? JSON.parse(body) : body;
          },
        };
      },
    },
  };
}

describe("handleProviderReport", () => {
  const stubDeps = {
    readHealthMetaKv: async () => ({ last_run_at: OBSERVED_AT }),
    readEconomicsCurrentKv: async () => null,
  };

  const providerArchive = {
    "providers/datura.json": {
      provider: { ...sampleProvider, netuids: [1] },
    },
    "profiles.json": {
      profiles: [{ netuid: 1, slug: "apex", name: "Apex" }],
    },
  };

  test("404 when provider artifact is missing", async () => {
    const res = await handleProviderReport(
      req("/api/v1/providers/missing/report"),
      createLocalArtifactEnv(),
      "missing",
      url("/api/v1/providers/missing/report"),
      stubDeps,
    );
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error.code, "provider_not_found");
  });

  test("400 invalid_slug when slug has invalid characters", async () => {
    const res = await handleProviderReport(
      req("/api/v1/providers/bad_slug/report"),
      createLocalArtifactEnv(),
      "bad_slug",
      url("/api/v1/providers/bad_slug/report"),
      stubDeps,
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "invalid_slug");
  });

  test("400 for unsupported query parameters", async () => {
    const env = createLocalArtifactEnv({
      ...archiveEnv({
        "providers/datura.json": { provider: sampleProvider },
      }),
    });
    const res = await handleProviderReport(
      req("/api/v1/providers/datura/report?cursor=abc"),
      env,
      "datura",
      url("/api/v1/providers/datura/report?cursor=abc"),
      stubDeps,
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "invalid_query");
    assert.equal(body.meta.parameter, "cursor");
  });

  test("503 when provider artifact read fails non-404", async () => {
    const env = createLocalArtifactEnv({
      METAGRAPH_R2_TIMEOUT_MS: "5",
      METAGRAPH_ARCHIVE: {
        async get() {
          return new Promise(() => {});
        },
      },
    });
    const res = await handleProviderReport(
      req("/api/v1/providers/datura/report"),
      env,
      "datura",
      url("/api/v1/providers/datura/report"),
      stubDeps,
    );
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error.code, "provider_not_found");
  });

  test("400 for unknown dimensions", async () => {
    const env = createLocalArtifactEnv({
      ...archiveEnv({
        "providers/datura.json": { provider: sampleProvider },
      }),
    });
    const res = await handleProviderReport(
      req("/api/v1/providers/datura/report?dimensions=bogus"),
      env,
      "datura",
      url("/api/v1/providers/datura/report?dimensions=bogus"),
      stubDeps,
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "invalid_query");
  });

  test("returns a live provider report with D1 overlays", async () => {
    const env = createLocalArtifactEnv({
      ...d1Env({
        "GROUP BY netuid, kind": [
          {
            netuid: 1,
            kind: "subnet-api",
            count: 1,
            ok_count: 1,
            avg_latency_ms: 42,
          },
        ],
        "GROUP BY netuid": [
          { netuid: 1, surface_count: 1, ok_count: 1, avg_latency_ms: 42 },
        ],
      }),
      ...archiveEnv({
        "providers/datura.json": {
          provider: { ...sampleProvider, netuids: [1] },
        },
        "profiles.json": {
          profiles: [{ netuid: 1, slug: "apex", name: "Apex" }],
        },
      }),
    });
    const res = await handleProviderReport(
      req("/api/v1/providers/datura/report?dimensions=surfaces,health"),
      env,
      "datura",
      url("/api/v1/providers/datura/report?dimensions=surfaces,health"),
      stubDeps,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.data.provider, "datura");
    assert.equal(body.data.subnets.length, 1);
    assert.equal(body.data.subnets[0].surfaces.count, 1);
    assert.equal(body.data.subnets[0].health.ok_count, 1);
  });

  test("health-only dimension skips surface kind D1 query", async () => {
    const env = createLocalArtifactEnv({
      ...d1Env({
        "GROUP BY netuid": [
          { netuid: 1, surface_count: 3, ok_count: 2, avg_latency_ms: 55 },
        ],
      }),
      ...archiveEnv(providerArchive),
    });
    const res = await handleProviderReport(
      req("/api/v1/providers/datura/report?dimensions=health"),
      env,
      "datura",
      url("/api/v1/providers/datura/report?dimensions=health"),
      stubDeps,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.subnets[0].health.ok_count, 2);
    assert.equal("surfaces" in body.data.subnets[0], false);
  });

  test("surfaces-only dimension skips health aggregate D1 query", async () => {
    const env = createLocalArtifactEnv({
      ...d1Env({
        "GROUP BY netuid, kind": [
          {
            netuid: 1,
            kind: "openapi",
            count: 2,
            ok_count: 1,
            avg_latency_ms: 30,
          },
        ],
      }),
      ...archiveEnv(providerArchive),
    });
    const res = await handleProviderReport(
      req("/api/v1/providers/datura/report?dimensions=surfaces"),
      env,
      "datura",
      url("/api/v1/providers/datura/report?dimensions=surfaces"),
      stubDeps,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.subnets[0].surfaces.count, 2);
    assert.equal("health" in body.data.subnets[0], false);
  });

  test("marks D1 fallback when surface_status is unavailable", async () => {
    const env = createLocalArtifactEnv({
      ...archiveEnv(providerArchive),
    });
    const res = await handleProviderReport(
      req("/api/v1/providers/datura/report?dimensions=surfaces,health"),
      env,
      "datura",
      url("/api/v1/providers/datura/report?dimensions=surfaces,health"),
      stubDeps,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.subnets[0].surfaces, null);
    assert.equal(body.data.subnets[0].health, null);
  });

  test("filters non-integer netuids from provider detail", async () => {
    const env = createLocalArtifactEnv({
      ...archiveEnv({
        "providers/datura.json": {
          provider: { ...sampleProvider, netuids: [1, "x", 1.5] },
        },
        "profiles.json": {
          profiles: [{ netuid: 1, slug: "apex", name: "Apex" }],
        },
      }),
    });
    const res = await handleProviderReport(
      req("/api/v1/providers/datura/report?dimensions=identity"),
      env,
      "datura",
      url("/api/v1/providers/datura/report?dimensions=identity"),
      stubDeps,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.data.identity.netuids, [1]);
  });

  test("tolerates missing profiles artifact and sparse profile rows", async () => {
    const env = createLocalArtifactEnv({
      ...archiveEnv({
        "providers/datura.json": {
          provider: { ...sampleProvider, netuids: [1] },
        },
      }),
    });
    const res = await handleProviderReport(
      req("/api/v1/providers/datura/report?dimensions=identity"),
      env,
      "datura",
      url("/api/v1/providers/datura/report?dimensions=identity"),
      stubDeps,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.subnets[0].found, false);
    assert.equal(body.data.subnets[0].name, null);
  });

  test("uses empty profiles when profiles.json omits the profiles array", async () => {
    const env = createLocalArtifactEnv({
      ...archiveEnv({
        "providers/datura.json": {
          provider: { ...sampleProvider, netuids: [1] },
        },
        "profiles.json": {},
      }),
    });
    const res = await handleProviderReport(
      req("/api/v1/providers/datura/report?dimensions=identity"),
      env,
      "datura",
      url("/api/v1/providers/datura/report?dimensions=identity"),
      stubDeps,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.subnets[0].found, false);
  });

  test("skips invalid profile netuids and nulls missing profile fields", async () => {
    const env = createLocalArtifactEnv({
      ...archiveEnv({
        "providers/datura.json": {
          provider: { ...sampleProvider, netuids: [1] },
        },
        "profiles.json": {
          profiles: [{ netuid: "bad" }, { netuid: 1 }],
        },
      }),
    });
    const res = await handleProviderReport(
      req("/api/v1/providers/datura/report?dimensions=identity"),
      env,
      "datura",
      url("/api/v1/providers/datura/report?dimensions=identity"),
      stubDeps,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.subnets[0].found, true);
    assert.equal(body.data.subnets[0].slug, null);
    assert.equal(body.data.subnets[0].name, null);
  });

  test("handles provider detail without a provider object or netuids", async () => {
    const env = createLocalArtifactEnv({
      ...archiveEnv({
        "providers/datura.json": {},
        "profiles.json": {
          profiles: [{ netuid: 1, slug: "apex", name: "Apex" }],
        },
      }),
    });
    const res = await handleProviderReport(
      req("/api/v1/providers/datura/report?dimensions=identity"),
      env,
      "datura",
      url("/api/v1/providers/datura/report?dimensions=identity"),
      stubDeps,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.found, false);
    assert.equal(body.data.identity, null);
    assert.deepEqual(body.data.subnets, []);
  });

  test("economics from live KV when economics:current is fresh", async () => {
    const liveEconomicsBlob = {
      contract_version: CONTRACT_VERSION,
      captured_at: new Date().toISOString(),
      schema_version: 1,
      summary: { with_economics_count: 1 },
      subnets: [
        {
          netuid: 1,
          registration_allowed: true,
          validator_count: 4,
          miner_count: 12,
          emission_share: 1,
        },
      ],
    };
    const env = createLocalArtifactEnv({
      ...archiveEnv(providerArchive),
    });
    const res = await handleProviderReport(
      req("/api/v1/providers/datura/report?dimensions=economics"),
      env,
      "datura",
      url("/api/v1/providers/datura/report?dimensions=economics"),
      {
        readHealthMetaKv: stubDeps.readHealthMetaKv,
        readEconomicsCurrentKv: async () => liveEconomicsBlob,
      },
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.subnets[0].economics.validator_count, 4);
  });

  test("economics falls back to committed economics.json when KV is cold", async () => {
    const env = createLocalArtifactEnv({
      ...archiveEnv({
        ...providerArchive,
        "economics.json": {
          subnets: [
            {
              netuid: 1,
              registration_allowed: false,
              validator_count: 9,
              miner_count: 20,
              emission_share: 1,
            },
          ],
        },
      }),
    });
    const res = await handleProviderReport(
      req("/api/v1/providers/datura/report?dimensions=economics"),
      env,
      "datura",
      url("/api/v1/providers/datura/report?dimensions=economics"),
      stubDeps,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.subnets[0].economics.validator_count, 9);
  });

  test("economics resolves to empty when live KV and artifact are cold", async () => {
    const env = createLocalArtifactEnv({
      ...archiveEnv(providerArchive),
    });
    const res = await handleProviderReport(
      req("/api/v1/providers/datura/report?dimensions=economics"),
      env,
      "datura",
      url("/api/v1/providers/datura/report?dimensions=economics"),
      stubDeps,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.subnets[0].economics, null);
  });
});

describe("GET /api/v1/providers/{slug}/report", () => {
  test("routes through handleRequest on mainnet", async () => {
    const env = createLocalArtifactEnv({
      ...d1Env({}),
      ...archiveEnv({
        "providers/datura.json": {
          provider: { ...sampleProvider, netuids: [1] },
        },
        "profiles.json": {
          profiles: [{ netuid: 1, slug: "apex", name: "Apex" }],
        },
      }),
    });
    const res = await handleRequest(
      req("/api/v1/providers/datura/report?dimensions=identity"),
      env,
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.identity.id, "datura");
  });
});

describe("canonicalProviderReportCachePath", () => {
  test("omits default dimensions from the cache key", () => {
    assert.equal(
      canonicalProviderReportCachePath(url("/api/v1/providers/datura/report")),
      "/api/v1/providers/datura/report",
    );
    assert.equal(
      canonicalProviderReportCachePath(
        url("/api/v1/providers/datura/report?dimensions=health"),
      ),
      "/api/v1/providers/datura/report?dimensions=health",
    );
  });

  test("returns null for invalid query strings", () => {
    assert.equal(
      canonicalProviderReportCachePath(
        url("/api/v1/providers/datura/report?dimensions=bogus"),
      ),
      null,
    );
    assert.equal(
      canonicalProviderReportCachePath(
        url("/api/v1/providers/datura/report?cursor=abc"),
      ),
      null,
    );
  });
});
