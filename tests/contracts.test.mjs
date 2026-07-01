import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, test } from "vitest";
import {
  API_ROUTES,
  API_QUERY_COLLECTIONS,
  CACHE_SECONDS,
  CONTRACT_VERSION,
  PUBLIC_ARTIFACTS,
  artifactPathFromTemplate,
  buildApiIndexArtifact,
  buildContractsArtifact,
  buildOpenApiArtifact,
  compileRoutePattern,
} from "../src/contracts.mjs";
import { evaluateArtifactBudgets } from "../scripts/artifact-budgets.mjs";
import { loadOpenApiComponentSchemas } from "../scripts/openapi-components.mjs";

describe("public contract registry", () => {
  test("keeps API routes and artifacts unique", () => {
    assert.equal(CONTRACT_VERSION, "2026-06-30.12");
    assert.equal(CACHE_SECONDS.short, 60);
    assert.equal(
      new Set(API_ROUTES.map((route) => route.id)).size,
      API_ROUTES.length,
    );
    assert.equal(
      new Set(PUBLIC_ARTIFACTS.map((artifact) => artifact.id)).size,
      PUBLIC_ARTIFACTS.length,
    );
    assert.equal(
      API_ROUTES.every(
        (route) =>
          route.path === "/api/v1" || route.path.startsWith("/api/v1/"),
      ),
      true,
    );
    assert.equal(
      PUBLIC_ARTIFACTS.every((artifact) =>
        artifact.path.startsWith("/metagraph/"),
      ),
      true,
    );
  });

  test("compiles templated route and artifact paths", () => {
    const subnetPattern = compileRoutePattern("/api/v1/subnets/{netuid}");
    const subnetMatch = subnetPattern.exec("/api/v1/subnets/74");
    assert.equal(subnetMatch.groups.netuid, "74");
    assert.equal(subnetPattern.test("/api/v1/subnets/not-a-number"), false);

    const adapterPattern = compileRoutePattern("/api/v1/adapters/{slug}");
    const adapterMatch = adapterPattern.exec("/api/v1/adapters/gittensor");
    assert.equal(adapterMatch.groups.slug, "gittensor");
    assert.equal(adapterPattern.test("/api/v1/adapters/Gittensor"), false);

    assert.equal(
      artifactPathFromTemplate("/metagraph/subnets/{netuid}.json", {
        netuid: 7,
      }),
      "/metagraph/subnets/7.json",
    );
    assert.equal(
      artifactPathFromTemplate("/metagraph/adapters/{slug}.json", {
        slug: "allways",
      }),
      "/metagraph/adapters/allways.json",
    );

    const historyPattern = compileRoutePattern("/api/v1/health/history/{date}");
    const historyMatch = historyPattern.exec(
      "/api/v1/health/history/2026-06-06",
    );
    assert.equal(historyMatch.groups.date, "2026-06-06");
    assert.equal(historyPattern.test("/api/v1/health/history/today"), false);
    assert.equal(
      artifactPathFromTemplate("/metagraph/health/history/{date}.json", {
        date: "2026-06-06",
      }),
      "/metagraph/health/history/2026-06-06.json",
    );

    const schemaPattern = compileRoutePattern(
      "/metagraph/schemas/{surface_id}.json",
    );
    const schemaMatch = schemaPattern.exec(
      "/metagraph/schemas/sn-56-gradients-openapi.json",
    );
    assert.equal(schemaMatch.groups.surface_id, "sn-56-gradients-openapi");
    assert.equal(
      schemaPattern.test("/metagraph/schemas/SN-56-gradients-openapi.json"),
      false,
    );
    assert.equal(
      artifactPathFromTemplate("/metagraph/schemas/{surface_id}.json", {
        surface_id: "sn-56-gradients-openapi",
      }),
      "/metagraph/schemas/sn-56-gradients-openapi.json",
    );
  });

  test("builds contracts, API index, and OpenAPI from one route table", async () => {
    const generatedAt = "1970-01-01T00:00:00.000Z";
    const contracts = buildContractsArtifact(generatedAt);
    const apiIndex = buildApiIndexArtifact(generatedAt, contracts);
    const openapi = buildOpenApiArtifact(
      generatedAt,
      await loadOpenApiComponentSchemas(generatedAt),
    );

    assert.equal(contracts.primary_domain, "api.metagraph.sh");
    assert.equal(contracts.openapi_url, "/metagraph/openapi.json");
    assert.equal(contracts.type_definitions_url, "/metagraph/types.d.ts");
    assert.equal(apiIndex.openapi_url, "/api/v1/openapi.json");
    assert.equal(apiIndex.routes.length, API_ROUTES.length);
    assert.equal(
      apiIndex.routes.find((route) => route.id === "subnets").query_collection,
      "subnets",
    );
    assert.equal(
      apiIndex.routes
        .find((route) => route.id === "subnets")
        .query_parameters.some((parameter) => parameter.name === "fields"),
      true,
    );
    assert.equal(
      apiIndex.routes
        .find((route) => route.id === "subnet-surfaces")
        .query_parameters.some((parameter) => parameter.name === "netuid"),
      false,
    );
    assert.equal(openapi.openapi, "3.1.0");
    assert.equal(openapi.info.version, CONTRACT_VERSION);
    assert.equal(Object.keys(openapi.paths).length, API_ROUTES.length);
    assert.equal(Boolean(openapi.components.schemas.SuccessEnvelope), true);
    assert.equal(Boolean(openapi.components.schemas.ErrorEnvelope), true);
    assert.equal(Boolean(openapi.components.schemas.Surface), true);
    assert.equal(Boolean(openapi.components.schemas.CandidateSurface), true);
    assert.equal(Boolean(openapi.components.schemas.EndpointResource), true);
    assert.equal(Boolean(openapi.components.schemas.EndpointsArtifact), true);
    assert.equal(Boolean(openapi.components.schemas.EndpointIncident), true);
    assert.equal(
      Boolean(openapi.components.schemas.EndpointIncidentsArtifact),
      true,
    );
    assert.equal(openapi["x-metagraphed"].generated_at, generatedAt);

    const subnetParameters = openapi.paths["/api/v1/subnets"].get.parameters;
    assert.equal(
      subnetParameters.find((parameter) => parameter.name === "fields").schema
        .pattern,
      "^[A-Za-z_][A-Za-z0-9_]*(,[A-Za-z_][A-Za-z0-9_]*)*$",
    );
    assert.deepEqual(
      subnetParameters.find((parameter) => parameter.name === "sort").schema
        .enum,
      API_QUERY_COLLECTIONS.subnets.sort_fields,
    );
    assert.deepEqual(
      subnetParameters.find((parameter) => parameter.name === "coverage_level")
        .schema.enum,
      ["native-only", "manifested", "probed"],
    );

    const candidateParameters =
      openapi.paths["/api/v1/candidates"].get.parameters;
    assert.equal(
      candidateParameters
        .find((parameter) => parameter.name === "state")
        .schema.enum.includes("schema-valid"),
      true,
    );

    const endpointParameters =
      openapi.paths["/api/v1/endpoints"].get.parameters;
    assert.deepEqual(
      endpointParameters.find((parameter) => parameter.name === "layer").schema
        .enum,
      ["bittensor-base", "data-provider", "docs-provider", "subnet-app"],
    );
    assert.equal(
      endpointParameters
        .find((parameter) => parameter.name === "sort")
        .schema.enum.includes("score"),
      true,
    );
    const endpointContract = contracts.artifacts.find(
      (artifact) => artifact.id === "endpoints",
    ).query_contract;
    assert.equal(endpointContract.collection, "endpoints");
    assert.deepEqual(endpointContract.range_filters, ["latency_ms", "score"]);
    assert.equal(
      endpointContract.query_parameters.some(
        (parameter) => parameter.name === "min_latency_ms",
      ),
      true,
    );
    assert.equal(
      endpointContract.query_parameters.some(
        (parameter) => parameter.name === "max_score",
      ),
      true,
    );

    const incidentParameters =
      openapi.paths["/api/v1/endpoint-incidents"].get.parameters;
    assert.deepEqual(
      incidentParameters.find((parameter) => parameter.name === "severity")
        .schema.enum,
      ["critical", "warning", "info"],
    );
    assert.deepEqual(
      incidentParameters.find((parameter) => parameter.name === "state").schema
        .enum,
      ["active", "resolved"],
    );
  });

  test("contracts artifact leaves query_contract null for non-route artifacts", () => {
    const contracts = buildContractsArtifact("1970-01-01T00:00:00.000Z");
    const typeDefinitions = contracts.artifacts.find(
      (artifact) => artifact.id === "type-definitions",
    );
    assert.equal(typeDefinitions.query_contract, null);
  });

  test("contracts artifact omits query_contract when a route's query collection metadata is absent", () => {
    const fakeRoute = {
      id: "test-missing-query-collection",
      method: "GET",
      path: "/api/v1/test-missing-query-collection",
      artifact_path: "/metagraph/test-missing-query-collection.json",
      description: "Synthetic route for query-contract fallback coverage.",
      cache: null,
      tags: ["test"],
      query_collection: "missing-query-collection",
      query_filter_names: null,
      query_parameters: null,
      path_parameters: [],
    };
    const fakeArtifact = {
      id: "test-missing-query-collection",
      path: fakeRoute.artifact_path,
      description: fakeRoute.description,
      schema_ref: null,
      storage_tier: "r2",
    };
    const routeCount = API_ROUTES.length;
    const artifactCount = PUBLIC_ARTIFACTS.length;

    API_ROUTES.push(fakeRoute);
    PUBLIC_ARTIFACTS.push(fakeArtifact);
    try {
      const contracts = buildContractsArtifact("1970-01-01T00:00:00.000Z");
      const entry = contracts.artifacts.find(
        (artifact) => artifact.id === fakeArtifact.id,
      );
      assert.equal(entry.query_contract, null);
    } finally {
      API_ROUTES.length = routeCount;
      PUBLIC_ARTIFACTS.length = artifactCount;
    }
  });

  test("API index preserves array-form route query parameters without inventing a collection", () => {
    const fakeRoute = {
      id: "test-array-query-parameters",
      method: "GET",
      path: "/api/v1/test-array-query-parameters",
      artifact_path: "/metagraph/test-array-query-parameters.json",
      description: "Synthetic route for array-form query parameter coverage.",
      cache: null,
      tags: ["test"],
      query_collection: null,
      query_filter_names: [],
      query_parameters: [{ name: "plain", schema: { type: "string" } }],
      path_parameters: [],
    };
    const routeCount = API_ROUTES.length;

    API_ROUTES.push(fakeRoute);
    try {
      const apiIndex = buildApiIndexArtifact("1970-01-01T00:00:00.000Z", {
        artifacts: [],
      });
      const route = apiIndex.routes.find((entry) => entry.id === fakeRoute.id);
      assert.equal(route.query_collection, null);
      assert.deepEqual(route.query_filter_names, []);
      assert.deepEqual(route.query_parameters, fakeRoute.query_parameters);
    } finally {
      API_ROUTES.length = routeCount;
    }
  });

  test("contracts artifact joins route metadata by artifact_path", () => {
    const contracts = buildContractsArtifact("1970-01-01T00:00:00.000Z");
    const apiIndexArtifact = contracts.artifacts.find(
      (artifact) => artifact.id === "api-index",
    );
    const endpointsArtifact = contracts.artifacts.find(
      (artifact) => artifact.id === "endpoints",
    );

    assert.equal(apiIndexArtifact.query_contract, null);
    assert.equal(endpointsArtifact.query_contract.collection, "endpoints");
    assert.deepEqual(endpointsArtifact.query_contract.sort_fields, [
      "kind",
      "last_checked",
      "latency_ms",
      "layer",
      "netuid",
      "pool_eligible",
      "provider",
      "publication_state",
      "score",
      "status",
    ]);
  });

  test("requires canonical component schemas before building OpenAPI", () => {
    assert.throws(
      () => buildOpenApiArtifact("1970-01-01T00:00:00.000Z", null),
      /requires canonical component schemas/,
    );
  });

  test("#747 Surface accepts a structured rate_limit and rejects malformed ones", async () => {
    const generatedAt = "1970-01-01T00:00:00.000Z";
    const openapi = buildOpenApiArtifact(
      generatedAt,
      await loadOpenApiComponentSchemas(generatedAt),
    );
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile({
      $id: "https://metagraph.sh/test/surface-rate-limit.json",
      components: openapi.components,
      $ref: "#/components/schemas/Surface",
    });
    const base = {
      id: "sn-1-test-api",
      netuid: 1,
      kind: "subnet-api",
      url: "https://example.io/api",
      provider: "tester",
      auth_required: false,
      authority: "official",
      public_safe: true,
    };

    // A well-formed structured limit (and the optional fields) validates.
    assert.equal(
      validate({
        ...base,
        rate_limit: {
          requests: 100,
          window: "60s",
          burst: 20,
          scope: "per-key",
          cost_notes: "Search calls cost 5 credits each.",
        },
      }),
      true,
      ajv.errorsText(validate.errors),
    );
    // requests + window are the minimum meaningful limit.
    assert.equal(validate({ ...base, rate_limit: { scope: "per-ip" } }), false);
    // scope is a closed enum.
    assert.equal(
      validate({
        ...base,
        rate_limit: { requests: 5, window: "1m", scope: "bogus" },
      }),
      false,
    );
    // the object is closed — no smuggling unknown keys.
    assert.equal(
      validate({
        ...base,
        rate_limit: { requests: 5, window: "1m", enforced: true },
      }),
      false,
    );
    // and it stays optional — a surface without it is still valid.
    assert.equal(validate(base), true, ajv.errorsText(validate.errors));
  });

  test("keeps public API route payloads on typed artifact schemas", async () => {
    const generatedAt = "1970-01-01T00:00:00.000Z";
    const openapi = buildOpenApiArtifact(
      generatedAt,
      await loadOpenApiComponentSchemas(generatedAt),
    );
    const genericAliases = Object.entries(openapi.components.schemas)
      .filter(
        ([name, schema]) =>
          name.endsWith("Artifact") &&
          JSON.stringify(schema) ===
            JSON.stringify({
              $ref: "#/components/schemas/GenericArtifact",
            }),
      )
      .map(([name]) => name);

    assert.deepEqual(genericAliases, []);

    for (const route of API_ROUTES) {
      const dataRef =
        openapi.paths[route.path][route.method.toLowerCase()].responses["200"]
          .content["application/json"].schema.allOf[1].properties.data.$ref;
      assert.notEqual(dataRef, "#/components/schemas/JsonObject");
      assert.notEqual(dataRef, "#/components/schemas/GenericArtifact");
    }
  });

  test("applies wildcard artifact budgets to dated health history", () => {
    const [result] = evaluateArtifactBudgets([
      {
        path: "health/history/2026-06-06.json",
        size_bytes: 350_000,
      },
    ]);

    assert.equal(result.status, "ok");
    assert.equal(result.warn_bytes, 650_000);
  });
});
