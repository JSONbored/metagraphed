import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import type { Row } from "./row-type.ts";

// Observe the real schema constructor, not a fake GraphQL response. Per-file
// isolation keeps this module mock out of every other MCP/GraphQL test.
const startup = vi.hoisted(() => ({ builds: 0, source: "" }));
vi.mock("graphql", async (importOriginal) => {
  const actual = await importOriginal<typeof import("graphql")>();
  return {
    ...actual,
    buildSchema(...args: Parameters<typeof actual.buildSchema>) {
      startup.builds++;
      startup.source = typeof args[0] === "string" ? args[0] : args[0].body;
      return actual.buildSchema(...args);
    },
  };
});

const { handleMcpRequest } = await import("../src/mcp-server.ts");

const readArtifact = async () => ({
  ok: true,
  data: {
    subnets: [{ netuid: 7, name: "Fixture subnet" }],
    providers: [{ slug: "fixture-provider", name: "Fixture provider" }],
    schemas: [{ surface_id: "fixture-schema" }],
  },
});

async function rpc(
  method: string,
  params: Row = {},
  path = "/mcp",
  env = {} as Env,
) {
  const response = await handleMcpRequest(
    new Request(`https://mcp.invalid${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    env,
    { readArtifact },
  );
  assert.equal(response.status, 200);
  return (await response.json()) as Row;
}

describe("MCP deferred GraphQL startup", () => {
  test("ordinary discovery in every profile leaves the GraphQL schema unbuilt", async () => {
    assert.equal(
      startup.builds,
      0,
      "importing MCP must not build the GraphQL schema",
    );
    for (const path of ["/mcp", "/mcp/core", "/mcp?catalog=full"]) {
      const initialized = await rpc(
        "initialize",
        {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "startup-fixture", version: "1" },
        },
        path,
      );
      assert.ok(initialized.result.capabilities.resources);
      assert.deepEqual((await rpc("ping", {}, path)).result, {});
      const listing = (await rpc("tools/list", {}, path)).result;
      assert.ok(listing.tools.length > 0);
      if (path.includes("catalog=full")) {
        assert.ok(
          listing.tools.some((tool: Row) => tool.name === "query_graphql"),
        );
      }
      const resources = (await rpc("resources/list", {}, path)).result
        .resources;
      assert.ok(
        resources.some(
          (resource: Row) => resource.uri === "metagraph://subnet/7",
        ),
      );
      assert.ok(
        resources.some(
          (resource: Row) =>
            resource.uri === "metagraph://provider/fixture-provider",
        ),
      );
      assert.ok(
        resources.some(
          (resource: Row) =>
            resource.uri === "metagraph://schema/fixture-schema",
        ),
      );
      assert.ok(
        (await rpc("prompts/list", {}, path)).result.prompts.length > 0,
      );
      assert.equal(startup.builds, 0);
    }
  });

  test("invalid and throttled GraphQL calls do not load its engine", async () => {
    const invalid = await rpc("tools/call", {
      name: "query_graphql",
      arguments: { query: "   " },
    });
    assert.equal(invalid.result.isError, true);
    const env = {
      RPC_RATE_LIMITER: {
        limit: async ({ key }: { key: string }) => ({
          success: !key.startsWith("gql:"),
        }),
      },
    } as unknown as Env;
    const limited = await rpc(
      "tools/call",
      {
        name: "query_graphql",
        arguments: { query: "{ __typename }" },
      },
      "/mcp",
      env,
    );
    assert.equal(
      limited.result.structuredContent.error.code,
      "graphql_rate_limited",
    );
    assert.equal(startup.builds, 0);
  });

  test("concurrent first queries build one real schema and retain query results", async () => {
    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        rpc("tools/call", {
          name: "query_graphql",
          arguments: { query: "{ __typename }" },
        }),
      ),
    );
    for (const response of responses) {
      assert.equal(response.result.isError, false);
      assert.deepEqual(response.result.structuredContent, {
        data: { __typename: "Query" },
        errors: [],
      });
    }
    assert.equal(startup.builds, 1);
    await rpc("resources/list");
    assert.equal(
      startup.builds,
      1,
      "later discovery must not rebuild the schema",
    );
  });

  test("reports the avoided schema-construction cost using the production SDL in remote CI", async () => {
    assert.equal(startup.builds, 1);
    assert.ok(startup.source.length > 1000);
    const { buildSchema } =
      await vi.importActual<typeof import("graphql")>("graphql");
    // Warm the constructor, then measure seven independent constructions of
    // the exact production SDL. This is fixture CPU cost, not live latency.
    buildSchema(startup.source);
    const samples = Array.from({ length: 7 }, () => {
      const began = performance.now();
      buildSchema(startup.source);
      return performance.now() - began;
    }).sort((a, b) => a - b);
    console.log(
      "MCP_GRAPHQL_STARTUP_FIXTURE",
      JSON.stringify({
        runtime: process.version,
        sdlBytes: Buffer.byteLength(startup.source),
        samples: samples.length,
        schemaConstructionMedianMs: samples[3],
        schemaConstructionMinMs: samples[0],
        schemaConstructionMaxMs: samples[6],
        ordinaryMcpStartupSchemaBuildsBefore: 1,
        ordinaryMcpStartupSchemaBuildsAfter: 0,
        firstGraphqlQuerySchemaBuildsAfter: startup.builds,
      }),
    );
    assert.equal(startup.builds, 1);
  });
});
