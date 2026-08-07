import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  CHANGELOG_ARTIFACT,
  GET_CHANGELOG_INSTRUCTIONS,
  GET_CHANGELOG_MCP_TOOL,
  GET_CHANGELOG_OUTPUT_SCHEMA,
  changelogToolError,
  loadChangelog,
} from "../src/changelog-mcp.ts";
import { MCP_INSTRUCTIONS, MCP_TOOLS } from "../src/mcp-server.ts";
import type { StorageReadResult } from "../workers/storage.ts";
import { mockEnv, type Row } from "./row-type.ts";

type ReadArtifact = (env: Env, path: string) => Promise<StorageReadResult>;

const SAMPLE_CHANGELOG = {
  // Required by GET_CHANGELOG_OUTPUT_SCHEMA and present on the real artifact
  // (GET /api/v1/changelog returns it alongside source/summary/artifacts).
  // The fixture predated the field and stopped validating when the schema
  // caught up with what the endpoint had been serving all along.
  schema_version: 1,
  contract_version: "2026-07-03.2",
  generated_at: "2026-08-07T10:09:17.651Z",
  source: "generated-artifact-diff",
  // The full summary the schema requires, matching GET /api/v1/changelog.
  // The fixture carried only the three artifact_* counts.
  summary: {
    artifact_added_count: 1,
    artifact_modified_count: 2,
    artifact_removed_count: 0,
    netuid_added_count: 0,
    netuid_removed_count: 0,
    netuid_renamed_count: 0,
    coverage_delta: {
      candidate_count: { before: 2171, after: 2174, delta: 3 },
      curated_overlay_count: { before: 129, after: 129, delta: 0 },
      native_only_count: { before: 0, after: 0, delta: 0 },
      provider_count: null,
      surface_count: { before: 3493, after: 3493, delta: 0 },
    },
  },
  artifacts: { added: [], modified: [], removed: [] },
  subnets: { added: [], removed: [], renamed: [] },
  notes: ["publish-time diff"],
};

describe("changelog-mcp", () => {
  test("changelogToolError is shaped for MCP toolError handling", () => {
    const err = changelogToolError("not_found", "missing");
    assert.equal(err.code, "not_found");
    assert.equal(err.toolError, true);
    assert.equal(err.message, "missing");
  });

  test("loadChangelog returns the baked artifact payload", async () => {
    const ctx = {
      env: mockEnv(),
      readArtifact: (async (_env: Env, path: string) => ({
        ok: true,
        data: path === CHANGELOG_ARTIFACT ? SAMPLE_CHANGELOG : null,
      })) as ReadArtifact,
    };
    const out = (await loadChangelog(ctx)) as Row;
    assert.equal(out.source, "generated-artifact-diff");
    assert.equal(out.summary.artifact_added_count, 1);
    assert.deepEqual(out.notes, ["publish-time diff"]);
  });

  test("loadChangelog uses an injected readArtifact dep", async () => {
    const out = (await loadChangelog(
      {
        env: mockEnv(),
        readArtifact: (async () => ({ ok: false })) as unknown as ReadArtifact,
      },
      {
        readArtifact: (async () => ({
          ok: true,
          data: {
            source: "test",
            summary: {},
            artifacts: {},
            subnets: {},
          },
        })) as unknown as ReadArtifact,
      },
    )) as Row;
    assert.equal(out.source, "test");
  });

  test("loadChangelog maps artifact_not_found to not_found", async () => {
    const ctx = {
      env: mockEnv(),
      readArtifact: (async () => ({
        ok: false,
        code: "artifact_not_found",
      })) as unknown as ReadArtifact,
    };
    await assert.rejects(
      () => loadChangelog(ctx),
      (err: Row) =>
        err.code === "not_found" &&
        err.toolError === true &&
        /unavailable in this environment/.test(err.message),
    );
  });

  test("loadChangelog surfaces other artifact failures with the path", async () => {
    const ctx = {
      env: mockEnv(),
      readArtifact: (async () => ({
        ok: false,
        code: "artifact_timeout",
      })) as unknown as ReadArtifact,
    };
    await assert.rejects(
      () => loadChangelog(ctx),
      (err: Row) =>
        err.code === "artifact_timeout" && /changelog\.json/.test(err.message),
    );
  });

  test("loadChangelog defaults code when the read result is bare", async () => {
    const ctx = {
      env: mockEnv(),
      readArtifact: (async () => ({ ok: false })) as unknown as ReadArtifact,
    };
    await assert.rejects(
      () => loadChangelog(ctx),
      (err: Row) => err.code === "artifact_unavailable",
    );
  });

  test("MCP tool metadata and outputSchema compile", () => {
    assert.equal(GET_CHANGELOG_MCP_TOOL.name, "get_changelog");
    assert.match(GET_CHANGELOG_INSTRUCTIONS, /get_changelog/);
    assert.deepEqual(
      // z.toJSONSchema()'s return type declares `properties` as optional (#8075).
      Object.keys(GET_CHANGELOG_MCP_TOOL.inputSchema.properties ?? {}),
      [],
    );
    assert.ok(
      new Ajv2020({ strict: false }).compile(GET_CHANGELOG_OUTPUT_SCHEMA),
    );
  });

  test("SAMPLE_CHANGELOG validates against GET_CHANGELOG_OUTPUT_SCHEMA", () => {
    const validate = new Ajv2020({ strict: false }).compile(
      GET_CHANGELOG_OUTPUT_SCHEMA,
    );
    assert.ok(validate(SAMPLE_CHANGELOG));
  });

  test("MCP server exports wire get_changelog", () => {
    assert.match(MCP_INSTRUCTIONS, /get_changelog/);
    const tool = MCP_TOOLS.find((t) => t.name === "get_changelog");
    assert.ok(tool);
    assert.equal(tool.title, GET_CHANGELOG_MCP_TOOL.title);
  });
});
