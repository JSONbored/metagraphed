import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  BUILD_SUMMARY_ARTIFACT,
  GET_BUILD_INSTRUCTIONS,
  GET_BUILD_MCP_TOOL,
  GET_BUILD_OUTPUT_SCHEMA,
  buildToolError,
  loadBuildSummary,
} from "../src/build-mcp.ts";
import { MCP_INSTRUCTIONS, MCP_TOOLS } from "../src/mcp-server.mjs";
import type { StorageReadResult } from "../workers/storage.ts";
import { mockEnv, type Row } from "./row-type.ts";

type ReadArtifact = (env: Env, path: string) => Promise<StorageReadResult>;

const SAMPLE_BUILD = {
  schema_version: 1,
  contract_version: "2026-07-01",
  generated_at: "2026-07-01T00:00:00.000Z",
  published_at: null,
  artifact_count: 42,
  artifact_size_bytes: 123456,
  subnet_count: 129,
  surface_count: 80,
  provider_count: 12,
  artifacts: [{ path: "subnets.json", size_bytes: 1000 }],
  coverage: { surface_count: 80 },
  artifact_budget_summary: { ok_count: 40, warn_count: 2, fail_count: 0 },
};

describe("build-mcp", () => {
  test("buildToolError is shaped for MCP toolError handling", () => {
    const err = buildToolError("not_found", "missing");
    assert.equal(err.code, "not_found");
    assert.equal(err.toolError, true);
    assert.equal(err.message, "missing");
  });

  test("loadBuildSummary returns the baked artifact payload", async () => {
    const ctx = {
      env: mockEnv(),
      readArtifact: (async (_env: Env, path: string) => ({
        ok: true,
        data: path === BUILD_SUMMARY_ARTIFACT ? SAMPLE_BUILD : null,
      })) as unknown as ReadArtifact,
    };
    const out = (await loadBuildSummary(ctx)) as Row;
    assert.equal(out.schema_version, 1);
    assert.equal(out.artifact_count, 42);
    assert.equal(out.artifacts.length, 1);
  });

  test("loadBuildSummary uses an injected readArtifact dep", async () => {
    const out = (await loadBuildSummary(
      {
        env: mockEnv(),
        readArtifact: (async () => ({ ok: false })) as unknown as ReadArtifact,
      },
      {
        readArtifact: (async () => ({
          ok: true,
          data: { schema_version: 1, artifact_count: 0, artifacts: [] },
        })) as unknown as ReadArtifact,
      },
    )) as Row;
    assert.equal(out.artifact_count, 0);
  });

  test("loadBuildSummary maps artifact_not_found to not_found", async () => {
    const ctx = {
      env: mockEnv(),
      readArtifact: (async () => ({
        ok: false,
        code: "artifact_not_found",
      })) as unknown as ReadArtifact,
    };
    await assert.rejects(
      () => loadBuildSummary(ctx),
      (err: Row) =>
        err.code === "not_found" &&
        err.toolError === true &&
        /unavailable in this environment/.test(err.message),
    );
  });

  test("loadBuildSummary surfaces other artifact failures with the path", async () => {
    const ctx = {
      env: mockEnv(),
      readArtifact: (async () => ({
        ok: false,
        code: "artifact_timeout",
      })) as unknown as ReadArtifact,
    };
    await assert.rejects(
      () => loadBuildSummary(ctx),
      (err: Row) =>
        err.code === "artifact_timeout" &&
        /build-summary\.json/.test(err.message),
    );
  });

  test("loadBuildSummary defaults code when the read result is bare", async () => {
    const ctx = {
      env: mockEnv(),
      readArtifact: (async () => ({ ok: false })) as unknown as ReadArtifact,
    };
    await assert.rejects(
      () => loadBuildSummary(ctx),
      (err: Row) => err.code === "artifact_unavailable",
    );
  });

  test("MCP tool metadata and outputSchema compile", () => {
    assert.equal(GET_BUILD_MCP_TOOL.name, "get_build");
    assert.match(GET_BUILD_INSTRUCTIONS, /get_build/);
    assert.deepEqual(
      Object.keys(GET_BUILD_MCP_TOOL.inputSchema.properties),
      [],
    );
    assert.ok(new Ajv2020({ strict: false }).compile(GET_BUILD_OUTPUT_SCHEMA));
  });

  test("SAMPLE_BUILD validates against GET_BUILD_OUTPUT_SCHEMA", () => {
    const validate = new Ajv2020({ strict: false }).compile(
      GET_BUILD_OUTPUT_SCHEMA,
    );
    assert.ok(validate(SAMPLE_BUILD));
  });

  test("MCP server exports wire get_build", () => {
    assert.match(MCP_INSTRUCTIONS, /get_build/);
    const tool = MCP_TOOLS.find((t) => t.name === "get_build");
    assert.ok(tool);
    assert.equal(tool.title, GET_BUILD_MCP_TOOL.title);
  });
});
