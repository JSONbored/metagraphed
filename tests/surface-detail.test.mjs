import assert from "node:assert/strict";
import { describe, test } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { buildOpenApiArtifact } from "../src/contracts.mjs";
import {
  composeSurfaceDetail,
  composeSurfaceLiveHealth,
  findCuratedSurface,
} from "../src/surface-detail.mjs";
import { handleRequest } from "../workers/api.mjs";
import { handleSurfaceDetail } from "../workers/request-handlers/surface-detail.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";
import { loadOpenApiComponentSchemas } from "../scripts/openapi-components.mjs";

const sampleSurface = {
  id: "7:subnet-api:apex",
  key: "srf-apex0001",
  netuid: 7,
  kind: "subnet-api",
  url: "https://apex.example/api",
  provider: "apex",
  auth_required: false,
  authority: "community",
  public_safe: true,
  classification: "live",
};

describe("surface-detail composition", () => {
  test("findCuratedSurface resolves id, key, and deprecated alias", () => {
    const surfaces = [sampleSurface];
    assert.equal(
      findCuratedSurface(surfaces, "7:subnet-api:apex")?.url,
      sampleSurface.url,
    );
    assert.equal(
      findCuratedSurface(surfaces, "srf-apex0001")?.url,
      sampleSurface.url,
    );
    assert.equal(
      findCuratedSurface(surfaces, "7:subnet-api:old", {
        aliases: [
          {
            deprecated_id: "7:subnet-api:old",
            surface_key: "srf-apex0001",
            current_id: "7:subnet-api:apex",
          },
        ],
      })?.url,
      sampleSurface.url,
    );
    assert.equal(findCuratedSurface(surfaces, "missing"), null);
  });

  test("composeSurfaceLiveHealth maps a live row and falls back to unavailable", () => {
    const live = {
      last_run_at: "2026-06-26T00:00:00.000Z",
      surfaces: [
        {
          netuid: 7,
          surface_id: "7:subnet-api:apex",
          surface_key: "srf-apex0001",
          status: "ok",
          classification: "live",
          latency_ms: 88,
          last_checked: "2026-06-26T00:00:00.000Z",
        },
      ],
    };
    assert.deepEqual(composeSurfaceLiveHealth(live, 7, sampleSurface), {
      status: "ok",
      classification: "live",
      latency_ms: 88,
      last_checked_at: "2026-06-26T00:00:00.000Z",
      observed_by: "live-cron-prober",
    });
    assert.deepEqual(composeSurfaceLiveHealth(null, 7, sampleSurface), {
      status: "unknown",
      classification: "live",
      latency_ms: null,
      last_checked_at: null,
      observed_by: "unavailable",
    });
  });

  test("composeSurfaceDetail wraps the surface and live overlay", () => {
    const data = composeSurfaceDetail({
      surface: sampleSurface,
      live: null,
      netuid: 7,
      observedAt: null,
    });
    assert.equal(data.schema_version, 1);
    assert.equal(data.source, "registry+live-cron-prober");
    assert.equal(data.observed_at, null);
    assert.deepEqual(data.surface, sampleSurface);
    assert.equal(data.live_health.status, "unknown");
    assert.equal(data.live_health.observed_by, "unavailable");
  });

  test("composeSurfaceDetail validates against SurfaceDetailArtifact", async () => {
    const generatedAt = "2026-06-26T12:00:00.000Z";
    const openapi = buildOpenApiArtifact(
      generatedAt,
      await loadOpenApiComponentSchemas(generatedAt),
    );
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile({
      $id: "https://metagraph.sh/test/surface-detail-artifact.json",
      components: openapi.components,
      $ref: "#/components/schemas/SurfaceDetailArtifact",
    });
    const data = composeSurfaceDetail({
      surface: sampleSurface,
      live: {
        last_run_at: generatedAt,
        surfaces: [
          {
            netuid: 7,
            surface_id: sampleSurface.id,
            status: "ok",
            classification: "live",
            latency_ms: 42,
            last_checked: generatedAt,
          },
        ],
      },
      netuid: 7,
      observedAt: generatedAt,
    });
    assert.equal(validate(data), true, ajv.errorsText(validate.errors));
  });
});

describe("GET /api/v1/subnets/{netuid}/surfaces/{surface_id}", () => {
  const env = createLocalArtifactEnv();
  const get = async (path) => {
    const res = await handleRequest(
      new Request(`https://api.metagraph.sh${path}`),
      env,
      {},
    );
    return { status: res.status, body: await res.json() };
  };

  test("returns one curated surface with live_health for a known id", async () => {
    const list = await get("/api/v1/subnets/7/surfaces?limit=1");
    assert.equal(list.status, 200);
    const surface = list.body.data?.surfaces?.[0];
    assert.ok(surface?.id, "expected at least one curated surface on netuid 7");

    const detail = await get(
      `/api/v1/subnets/7/surfaces/${encodeURIComponent(surface.id)}`,
    );
    assert.equal(detail.status, 200);
    assert.equal(detail.body.ok, true);
    assert.equal(detail.body.data.surface.id, surface.id);
    assert.equal(typeof detail.body.data.live_health.status, "string");
    assert.equal(typeof detail.body.data.live_health.observed_by, "string");
    assert.equal(
      detail.body.meta.artifact_path,
      `/metagraph/surfaces/7/${surface.id}.json`,
    );
  });

  test("resolves stable key on the HTTP route", async () => {
    const list = await get("/api/v1/subnets/7/surfaces?limit=1");
    const surface = list.body.data?.surfaces?.[0];
    assert.ok(surface?.key);

    const detail = await get(
      `/api/v1/subnets/7/surfaces/${encodeURIComponent(surface.key)}`,
    );
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.surface.id, surface.id);
  });

  test("404 for unknown surface id on an existing subnet", async () => {
    const { status, body } = await get(
      "/api/v1/subnets/7/surfaces/no-such-surface-id",
    );
    assert.equal(status, 404);
    assert.equal(body.error?.code, "surface_not_found");
  });

  test("400 for invalid surface_id characters", async () => {
    const { status, body } = await get("/api/v1/subnets/7/surfaces/bad%20id");
    assert.equal(status, 400);
    assert.equal(body.error?.code, "invalid_surface_id");
  });

  test("404 artifact_unavailable when subnet has no surfaces file", async () => {
    const { status, body } = await get(
      "/api/v1/subnets/999999/surfaces/no-such-surface",
    );
    assert.equal(status, 404);
    assert.equal(body.error?.code, "artifact_unavailable");
    assert.equal(body.meta?.netuid, 999999);
  });
});

const stubHealthDeps = {
  resolveLiveHealth: async () => null,
  readHealthKv: async () => null,
};

function detailRequest(path = "/") {
  return new Request(`https://api.metagraph.sh${path}`);
}

describe("handleSurfaceDetail", () => {
  test("400 invalid_netuid when netuid is negative or non-integer", async () => {
    for (const netuid of [-1, 1.5, Number.NaN]) {
      const res = await handleSurfaceDetail(
        detailRequest(),
        createLocalArtifactEnv(),
        netuid,
        "some-surface",
        stubHealthDeps,
      );
      assert.equal(res.status, 400, `netuid=${netuid}`);
      const body = await res.json();
      assert.equal(body.error?.code, "invalid_netuid");
    }
  });

  test("404 artifact_unavailable when curated surfaces artifact is missing", async () => {
    const res = await handleSurfaceDetail(
      detailRequest(),
      createLocalArtifactEnv(),
      999999,
      "some-surface",
      stubHealthDeps,
    );
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error?.code, "artifact_unavailable");
    assert.equal(body.meta?.artifact_path, "/metagraph/surfaces/999999.json");
  });

  test("503 artifact_unavailable when surfaces artifact read fails non-404", async () => {
    const env = createLocalArtifactEnv({
      METAGRAPH_R2_TIMEOUT_MS: 1,
      METAGRAPH_ARCHIVE: {
        async get() {
          await new Promise(() => {});
        },
      },
    });
    const res = await handleSurfaceDetail(
      detailRequest(),
      env,
      7,
      "some-surface",
      stubHealthDeps,
    );
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error?.code, "artifact_unavailable");
  });
});
