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
});
