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
import {
  MCP_INSTRUCTIONS,
  MCP_SERVER_VERSION,
  MCP_TOOLS,
} from "../src/mcp-server.mjs";

const SAMPLE_BLOB = {
  generated_at: "2026-07-01T00:00:00.000Z",
  summary: { subnet_count: 129, callable_service_count: 42 },
  copyable_agent: { url: "https://api.metagraph.sh/agent.md" },
  mcp: {
    endpoint: "https://api.metagraph.sh/mcp",
    tools: [{ name: "get_subnet" }],
  },
  resources: [
    { id: "agent", title: "Copyable AI agent", url: "https://x/agent.md" },
  ],
};

function readArtifact(_env, path) {
  if (path === AGENT_RESOURCES_ARTIFACT) {
    return Promise.resolve({ ok: true, data: SAMPLE_BLOB });
  }
  return Promise.resolve({ ok: false, code: "artifact_not_found" });
}

describe("agent-resources-mcp", () => {
  test("agentResourcesToolError is shaped for MCP toolError handling", () => {
    const err = agentResourcesToolError("not_found", "missing");
    assert.equal(err.code, "not_found");
    assert.equal(err.toolError, true);
    assert.equal(err.message, "missing");
  });

  test("loadAgentResources returns the baked artifact payload", async () => {
    const out = await loadAgentResources({ env: {}, readArtifact });
    assert.equal(out.summary.subnet_count, 129);
    assert.equal(out.resources[0].id, "agent");
    assert.equal(out.mcp.tools[0].name, "get_subnet");
  });

  test("loadAgentResources uses an injected readArtifact dep", async () => {
    const out = await loadAgentResources(
      { env: {}, readArtifact: async () => ({ ok: false }) },
      {
        readArtifact: async () => ({
          ok: true,
          data: { resources: [], mcp: { tools: [] } },
        }),
      },
    );
    assert.deepEqual(out.resources, []);
  });

  test("loadAgentResources maps artifact_not_found to not_found", async () => {
    await assert.rejects(
      () =>
        loadAgentResources(
          {
            env: {},
            readArtifact: async () => ({
              ok: false,
              code: "artifact_not_found",
            }),
          },
          {},
        ),
      (err) =>
        err.code === "not_found" &&
        /AI-resources index is unavailable/.test(err.message),
    );
  });

  test("loadAgentResources surfaces other artifact failures with the path", async () => {
    await assert.rejects(
      () =>
        loadAgentResources(
          {
            env: {},
            readArtifact: async () => ({
              ok: false,
              code: "artifact_timeout",
            }),
          },
          {},
        ),
      (err) =>
        err.code === "artifact_timeout" &&
        /agent-resources\.json/.test(err.message),
    );
  });

  test("loadAgentResources defaults code when the read result is bare", async () => {
    await assert.rejects(
      () =>
        loadAgentResources(
          {
            env: {},
            readArtifact: async () => ({ ok: false }),
          },
          {},
        ),
      (err) => err.code === "artifact_unavailable",
    );
  });

  test("loadAgentResources rejects a malformed artifact payload", async () => {
    await assert.rejects(
      () =>
        loadAgentResources(
          {
            env: {},
            readArtifact: async () => ({ ok: true, data: null }),
          },
          {},
        ),
      (err) =>
        err.code === "not_found" &&
        /AI-resources index is unavailable/.test(err.message),
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

  test("MCP server exports wire get_agent_resources at the bumped SemVer", () => {
    assert.equal(MCP_SERVER_VERSION, "1.25.0");
    assert.match(MCP_INSTRUCTIONS, /get_agent_resources/);
    const tool = MCP_TOOLS.find((t) => t.name === "get_agent_resources");
    assert.ok(tool);
    assert.equal(tool.title, "Get the AI-resources index");
  });
});
