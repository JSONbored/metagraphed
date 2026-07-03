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
    assert.equal(CONTRACT_VERSION, "2026-07-03.1");
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
    const aliasMatch = schemaPattern.exec(
      "/metagraph/schemas/7:subnet-api:new_v2.json",
    );
    assert.equal(aliasMatch.groups.surface_id, "7:subnet-api:new_v2");
    assert.equal(
      schemaPattern.test("/metagraph/schemas/../secrets.json"),
      false,
    );
    assert.equal(
      artifactPathFromTemplate("/metagraph/schemas/{surface_id}.json", {
        surface_id: "7:subnet-api:new_v2",
      }),
      "/metagraph/schemas/7:subnet-api:new_v2.json",
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
    const fixtureArtifactSchema = openapi.components.schemas.FixtureArtifact;
    assert.equal(
      fixtureArtifactSchema.allOf.some(
        (branch) => branch.$ref === "#/components/schemas/ArtifactBase",
      ),
      true,
    );
    const fixtureDetailSchema = fixtureArtifactSchema.allOf.find(
      (branch) => branch.properties?.response,
    );
    assert.equal(
      fixtureDetailSchema.properties.surface_id.pattern,
      "^[A-Za-z0-9][A-Za-z0-9:._-]*$",
    );
    assert.equal(
      fixtureDetailSchema.properties.request.properties.method.const,
      "GET",
    );
    assert.equal(
      fixtureDetailSchema.properties.kind.$ref,
      "#/components/schemas/SurfaceKind",
    );
    const fixtureBodySchema =
      fixtureDetailSchema.properties.response.properties.body;
    assert.equal(
      fixtureBodySchema.anyOf.some(
        (branch) => branch.$ref === "#/components/schemas/JsonObject",
      ),
      true,
    );
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

    const fixtureExample =
      openapi.paths["/api/v1/fixtures/{surface_id}"].get.responses["200"]
        .content["application/json"].example;
    assert.equal(fixtureExample.data.surface_id, "7:subnet-api:new_v2");
    assert.equal(fixtureExample.data.response.status, 200);
    assert.deepEqual(fixtureExample.data.response.body, { ok: true });
    assert.equal(
      fixtureExample.meta.artifact_path,
      "/metagraph/fixtures/7:subnet-api:new_v2.json",
    );
    assert.equal(fixtureExample.meta.cache, "standard");
    assert.equal(fixtureExample.meta.source, "r2");
    assert.equal(fixtureExample.meta.pagination, undefined);
    assert.equal(fixtureExample.meta.stale_contract, undefined);

    const csvExamples = [
      [
        "/api/v1/subnets/{netuid}/metagraph",
        "uid,hotkey,coldkey,active,validator_permit,rank,trust,validator_trust,consensus,incentive,dividends,emission_tao,stake_tao,registered_at_block,is_immunity_period,axon",
      ],
      [
        "/api/v1/subnets/{netuid}/validators",
        "uid,hotkey,coldkey,active,validator_permit,rank,trust,validator_trust,consensus,incentive,dividends,emission_tao,stake_tao,registered_at_block,is_immunity_period,axon",
      ],
      [
        "/api/v1/subnets/movers",
        "netuid,stake_start_tao,stake_end_tao,stake_delta_tao,stake_pct_change,emission_start_tao,emission_end_tao,emission_delta_tao,emission_pct_change,validators_start,validators_end,validators_delta,neurons_start,neurons_end,neurons_delta",
      ],
      [
        "/api/v1/validators",
        "hotkey,coldkey,coldkey_count,subnet_count,uid_count,total_stake_tao,total_emission_tao,stake_dominance,avg_validator_trust,max_validator_trust,latest_captured_at,latest_block_number,subnets",
      ],
      [
        "/api/v1/economics/trends",
        "snapshot_date,subnet_count,total_stake_tao,alpha_price_tao_weighted,alpha_price_tao_median,validator_count,miner_count,mean_emission_share",
      ],
    ];
    for (const [path, expectedHeader] of csvExamples) {
      const csvContent =
        openapi.paths[path].get.responses["200"].content["text/csv"];
      assert.equal(csvContent.schema.type, "string");
      assert.equal(csvContent.example.split("\r\n")[0], expectedHeader);
    }

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
