import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  SELF_HEALTH_ARTIFACT,
  GET_SELF_HEALTH_INSTRUCTIONS,
  GET_SELF_HEALTH_MCP_TOOL,
  GET_SELF_HEALTH_OUTPUT_SCHEMA,
  selfHealthToolError,
  loadSelfHealth,
} from "../src/self-health-mcp.ts";
import { MCP_INSTRUCTIONS, MCP_TOOLS } from "../src/mcp-server.ts";
import type { StorageReadResult } from "../workers/storage.ts";
import { mockEnv, type Row } from "./row-type.ts";

type ReadArtifact = (env: Env, path: string) => Promise<StorageReadResult>;

const SAMPLE_SELF_HEALTH = {
  schema_version: 1,
  verdict: "operational",
  components: [
    {
      component: "api",
      current_ok: true,
      http_status: 200,
      latency_ms: 42,
      checked_at: "2026-07-01T00:00:00.000Z",
      note: null,
      days: [
        { day: "2026-06-30", checks: 1440, ok_count: 1440, uptime_ratio: 1 },
      ],
      uptime_90d: 0.999,
    },
    {
      component: "site",
      current_ok: null,
      http_status: null,
      latency_ms: null,
      checked_at: null,
      note: null,
      days: [],
      uptime_90d: null,
    },
  ],
  measured_component_count: 1,
  observed_at: "2026-07-01T00:00:00.000Z",
};

describe("self-health-mcp", () => {
  test("selfHealthToolError is shaped for MCP toolError handling", () => {
    const err = selfHealthToolError("not_found", "missing");
    assert.equal(err.code, "not_found");
    assert.equal(err.toolError, true);
    assert.equal(err.message, "missing");
  });

  test("loadSelfHealth returns the baked artifact payload", async () => {
    const ctx = {
      env: mockEnv(),
      readArtifact: (async (_env: Env, path: string) => ({
        ok: true,
        data: path === SELF_HEALTH_ARTIFACT ? SAMPLE_SELF_HEALTH : null,
      })) as unknown as ReadArtifact,
    };
    const out = (await loadSelfHealth(ctx)) as Row;
    assert.equal(out.schema_version, 1);
    assert.equal(out.verdict, "operational");
    assert.equal(out.components.length, 2);
    assert.equal(out.components[0].days[0].uptime_ratio, 1);
  });

  test("loadSelfHealth uses an injected readArtifact dep", async () => {
    const out = (await loadSelfHealth(
      {
        env: mockEnv(),
        readArtifact: (async () => ({ ok: false })) as unknown as ReadArtifact,
      },
      {
        readArtifact: (async () => ({
          ok: true,
          data: {
            schema_version: 1,
            verdict: "degraded",
            components: [],
            measured_component_count: 0,
            observed_at: null,
          },
        })) as unknown as ReadArtifact,
      },
    )) as Row;
    assert.equal(out.verdict, "degraded");
  });

  test("loadSelfHealth maps artifact_not_found to not_found", async () => {
    const ctx = {
      env: mockEnv(),
      readArtifact: (async () => ({
        ok: false,
        code: "artifact_not_found",
      })) as unknown as ReadArtifact,
    };
    await assert.rejects(
      () => loadSelfHealth(ctx),
      (err: Row) =>
        err.code === "not_found" &&
        err.toolError === true &&
        /unavailable in this environment/.test(err.message),
    );
  });

  test("loadSelfHealth surfaces other artifact failures with the path", async () => {
    const ctx = {
      env: mockEnv(),
      readArtifact: (async () => ({
        ok: false,
        code: "artifact_timeout",
      })) as unknown as ReadArtifact,
    };
    await assert.rejects(
      () => loadSelfHealth(ctx),
      (err: Row) =>
        err.code === "artifact_timeout" &&
        /self-health\.json/.test(err.message),
    );
  });

  test("loadSelfHealth defaults code when the read result is bare", async () => {
    const ctx = {
      env: mockEnv(),
      readArtifact: (async () => ({ ok: false })) as unknown as ReadArtifact,
    };
    await assert.rejects(
      () => loadSelfHealth(ctx),
      (err: Row) => err.code === "artifact_unavailable",
    );
  });

  test("MCP tool metadata and outputSchema compile", () => {
    assert.equal(GET_SELF_HEALTH_MCP_TOOL.name, "get_self_health");
    assert.match(GET_SELF_HEALTH_INSTRUCTIONS, /get_self_health/);
    assert.deepEqual(
      Object.keys(GET_SELF_HEALTH_MCP_TOOL.inputSchema.properties ?? {}),
      [],
    );
    assert.ok(
      new Ajv2020({ strict: false }).compile(GET_SELF_HEALTH_OUTPUT_SCHEMA),
    );
  });

  test("SAMPLE_SELF_HEALTH validates against GET_SELF_HEALTH_OUTPUT_SCHEMA", () => {
    const validate = new Ajv2020({ strict: false }).compile(
      GET_SELF_HEALTH_OUTPUT_SCHEMA,
    );
    assert.ok(validate(SAMPLE_SELF_HEALTH));
  });

  test("MCP server exports wire get_self_health", () => {
    assert.match(MCP_INSTRUCTIONS, /get_self_health/);
    const tool = MCP_TOOLS.find((t) => t.name === "get_self_health");
    assert.ok(tool);
    assert.equal(tool.title, GET_SELF_HEALTH_MCP_TOOL.title);
  });
});
