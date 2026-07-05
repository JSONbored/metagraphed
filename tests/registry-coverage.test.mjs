import assert from "node:assert/strict";
import { describe, test } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import {
  GET_COVERAGE_INSTRUCTIONS,
  GET_COVERAGE_MCP_TOOL,
  GET_COVERAGE_OUTPUT_SCHEMA,
  REGISTRY_COVERAGE_ARTIFACT,
  loadRegistryCoverage,
  registryCoverageToolError,
} from "../src/registry-coverage.mjs";
import {
  MCP_INSTRUCTIONS,
  MCP_SERVER_VERSION,
  MCP_TOOLS,
} from "../src/mcp-server.mjs";

const SAMPLE_COVERAGE = {
  surface_count: 120,
  official_surface_count: 80,
  completeness: { average_score: 72, scored_subnet_count: 129 },
  domain_coverage: { docs: 100, schema: 90 },
};

describe("registry-coverage", () => {
  test("registryCoverageToolError is shaped for MCP toolError handling", () => {
    const err = registryCoverageToolError("not_found", "missing");
    assert.equal(err.code, "not_found");
    assert.equal(err.toolError, true);
    assert.equal(err.message, "missing");
  });

  test("loadRegistryCoverage returns the baked artifact payload", async () => {
    const ctx = {
      env: {},
      readArtifact: async (_env, path) => ({
        ok: true,
        data: path === REGISTRY_COVERAGE_ARTIFACT ? SAMPLE_COVERAGE : null,
      }),
    };
    const out = await loadRegistryCoverage(ctx);
    assert.equal(out.surface_count, 120);
    assert.equal(out.completeness.average_score, 72);
  });

  test("loadRegistryCoverage uses an injected readArtifact dep", async () => {
    const out = await loadRegistryCoverage(
      { env: {}, readArtifact: async () => ({ ok: false }) },
      {
        readArtifact: async () => ({
          ok: true,
          data: { surface_count: 1, completeness: {} },
        }),
      },
    );
    assert.equal(out.surface_count, 1);
  });

  test("loadRegistryCoverage maps artifact_not_found to not_found", async () => {
    const ctx = {
      env: {},
      readArtifact: async () => ({
        ok: false,
        code: "artifact_not_found",
      }),
    };
    await assert.rejects(
      () => loadRegistryCoverage(ctx),
      (err) => err.code === "not_found" && err.toolError === true,
    );
  });

  test("loadRegistryCoverage surfaces other artifact failures with the path", async () => {
    const ctx = {
      env: {},
      readArtifact: async () => ({
        ok: false,
        code: "artifact_timeout",
      }),
    };
    await assert.rejects(
      () => loadRegistryCoverage(ctx),
      (err) =>
        err.code === "artifact_timeout" && /coverage\.json/.test(err.message),
    );
  });

  test("loadRegistryCoverage defaults code when the read result is bare", async () => {
    const ctx = {
      env: {},
      readArtifact: async () => ({ ok: false }),
    };
    await assert.rejects(
      () => loadRegistryCoverage(ctx),
      (err) => err.code === "artifact_unavailable",
    );
  });

  test("MCP tool metadata and outputSchema compile", () => {
    assert.equal(GET_COVERAGE_MCP_TOOL.name, "get_coverage");
    assert.match(GET_COVERAGE_INSTRUCTIONS, /get_coverage/);
    assert.deepEqual(
      Object.keys(GET_COVERAGE_MCP_TOOL.inputSchema.properties),
      [],
    );
    assert.ok(
      new Ajv2020({ strict: false }).compile(GET_COVERAGE_OUTPUT_SCHEMA),
    );
  });

  test("MCP server exports wire get_coverage at the bumped SemVer", () => {
    assert.equal(MCP_SERVER_VERSION, "1.63.0");
    assert.match(MCP_INSTRUCTIONS, /get_coverage/);
    const tool = MCP_TOOLS.find((t) => t.name === "get_coverage");
    assert.ok(tool);
    assert.equal(tool.title, "Get registry coverage summary");
  });
});
