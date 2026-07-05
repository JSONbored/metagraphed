import assert from "node:assert/strict";
import { describe, test } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import {
  AGENT_RESOURCES_ARTIFACT,
  GET_AGENT_RESOURCES_INSTRUCTIONS,
  GET_AGENT_RESOURCES_MCP_TOOL,
  GET_AGENT_RESOURCES_OUTPUT_SCHEMA,
  agentResourcesToolError,
  loadAgentResources,
} from "../src/agent-resources-mcp.mjs";
import { MCP_INSTRUCTIONS, MCP_TOOLS } from "../src/mcp-server.mjs";

const SAMPLE_RESOURCES = {
  summary: { subnet_count: 129, callable_service_count: 42 },
  copyable_agent: {
    title: "Bittensor integration agent",
    url: "https://api.metagraph.sh/agent.md",
  },
  mcp: {
    endpoint: "https://api.metagraph.sh/mcp",
    transport: "streamable-http",
    tools: [{ name: "search_subnets", title: "Search subnets" }],
  },
  resources: [
    { id: "agent", kind: "agent", url: "https://api.metagraph.sh/agent.md" },
  ],
};

describe("agent-resources-mcp", () => {
  test("agentResourcesToolError is shaped for MCP toolError handling", () => {
    const err = agentResourcesToolError("not_found", "missing");
    assert.equal(err.code, "not_found");
    assert.equal(err.toolError, true);
    assert.equal(err.message, "missing");
  });

  test("loadAgentResources returns the baked artifact payload", async () => {
    const ctx = {
      env: {},
      readArtifact: async (_env, path) => ({
        ok: true,
        data: path === AGENT_RESOURCES_ARTIFACT ? SAMPLE_RESOURCES : null,
      }),
    };
    const out = await loadAgentResources(ctx);
    assert.equal(out.summary.subnet_count, 129);
    assert.equal(out.mcp.transport, "streamable-http");
    assert.equal(out.resources.length, 1);
  });

  test("loadAgentResources uses an injected readArtifact dep", async () => {
    const out = await loadAgentResources(
      { env: {}, readArtifact: async () => ({ ok: false }) },
      {
        readArtifact: async () => ({
          ok: true,
          data: { resources: [], mcp: {} },
        }),
      },
    );
    assert.deepEqual(out.resources, []);
  });

  test("loadAgentResources maps artifact_not_found to not_found", async () => {
    const ctx = {
      env: {},
      readArtifact: async () => ({
        ok: false,
        code: "artifact_not_found",
      }),
    };
    await assert.rejects(
      () => loadAgentResources(ctx),
      (err) =>
        err.code === "not_found" &&
        err.toolError === true &&
        /unavailable in this environment/.test(err.message),
    );
  });

  test("loadAgentResources surfaces other artifact failures with the path", async () => {
    const ctx = {
      env: {},
      readArtifact: async () => ({
        ok: false,
        code: "artifact_timeout",
      }),
    };
    await assert.rejects(
      () => loadAgentResources(ctx),
      (err) =>
        err.code === "artifact_timeout" &&
        /agent-resources\.json/.test(err.message),
    );
  });

  test("loadAgentResources defaults code when the read result is bare", async () => {
    const ctx = {
      env: {},
      readArtifact: async () => ({ ok: false }),
    };
    await assert.rejects(
      () => loadAgentResources(ctx),
      (err) => err.code === "artifact_unavailable",
    );
  });

  test("loadAgentResources rejects a null payload as not_found", async () => {
    const ctx = {
      env: {},
      readArtifact: async () => ({ ok: true, data: null }),
    };
    await assert.rejects(
      () => loadAgentResources(ctx),
      (err) => err.code === "not_found",
    );
  });

  test("loadAgentResources rejects a non-object payload as not_found", async () => {
    const ctx = {
      env: {},
      readArtifact: async () => ({ ok: true, data: "not-json" }),
    };
    await assert.rejects(
      () => loadAgentResources(ctx),
      (err) => err.code === "not_found",
    );
  });

  test("MCP tool metadata and outputSchema compile", () => {
    assert.equal(GET_AGENT_RESOURCES_MCP_TOOL.name, "get_agent_resources");
    assert.match(GET_AGENT_RESOURCES_INSTRUCTIONS, /get_agent_resources/);
    assert.deepEqual(
      Object.keys(GET_AGENT_RESOURCES_MCP_TOOL.inputSchema.properties),
      [],
    );
    assert.ok(
      new Ajv2020({ strict: false }).compile(GET_AGENT_RESOURCES_OUTPUT_SCHEMA),
    );
  });

  test("MCP server exports wire get_agent_resources", () => {
    assert.match(MCP_INSTRUCTIONS, /get_agent_resources/);
    const tool = MCP_TOOLS.find((t) => t.name === "get_agent_resources");
    assert.ok(tool);
    assert.equal(tool.title, "Get the AI-resources index");
  });
});
