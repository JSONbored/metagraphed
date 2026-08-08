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
import { MCP_INSTRUCTIONS, MCP_TOOLS } from "../src/mcp-server.ts";
import type { StorageReadResult } from "../workers/storage.ts";
import { mockEnv, type Row } from "./row-type.ts";
import { assertValid } from "./helpers/assert-valid.ts";

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
  // A REAL captured /api/v1/coverage response (2026-08-07). #9796 derived
  // get_build's outputSchema from BuildSummaryArtifactSchema, which types this
  // field as the CoverageArtifact rather than an open object; a one-key stub
  // satisfied the open object and nothing else.
  coverage: {
    application_subnet_count: 128,
    candidate_count: 2174,
    candidate_subnet_count: 129,
    chain_subnet_count: 129,
    completeness: {
      average_score: 81,
      dimension_coverage: {
        community: {
          pct: 72,
          present: 93,
        },
        "data-artifact": {
          pct: 92,
          present: 119,
        },
        docs: {
          pct: 100,
          present: 129,
        },
        openapi: {
          pct: 50,
          present: 65,
        },
        "source-repo": {
          pct: 95,
          present: 123,
        },
        sse: {
          pct: 4,
          present: 5,
        },
        "subnet-api": {
          pct: 94,
          present: 121,
        },
        website: {
          pct: 95,
          present: 122,
        },
      },
      fully_complete_count: 4,
      fully_complete_pct: 3,
      median_score: 78,
      methodology:
        "Per-subnet completeness_score (0-100) weighs curated public identity and operational interface coverage. Full per-subnet scores and gaps live at /metagraph/review/profile-completeness.json; the sortable leaderboard is /api/v1/profiles?sort=completeness_score&order=asc.",
      score_distribution: {
        "100": 3,
        "0-24": 0,
        "25-49": 4,
        "50-74": 25,
        "75-99": 97,
      },
      scored_subnet_count: 129,
    },
    contract_version: "2026-07-03.2",
    curated_overlay_count: 129,
    curation_level_counts: {
      "adapter-backed": 2,
      "maintainer-reviewed": 127,
    },
    domain_coverage: {
      agents: 13,
      compute: 9,
      data: 9,
      finance: 9,
      inference: 16,
      media: 4,
      prediction: 7,
      privacy: 2,
      robotics: 3,
      science: 5,
      search: 2,
      security: 4,
      storage: 1,
    },
    first_party_subnet_count: 116,
    generated_at: "2026-08-07T10:09:17.651Z",
    manifested_count: 0,
    native_only_count: 0,
    native_only_with_candidates: 0,
    native_only_without_candidates: 0,
    native_snapshot_captured_at: "2026-08-07T10:10:10Z",
    network: "finney",
    official_surface_count: 444,
    probed_count: 129,
    probed_surface_count: 1859,
    registry_observed_surface_count: 785,
    root_subnet_count: 1,
    schema_version: 1,
    source: {
      candidates: "registry/candidates",
      native: {
        identity_storage: "SubtensorModule.SubnetIdentitiesV3",
        kind: "bittensor-sdk",
        method:
          "SubtensorApi.metagraphs.get_all_metagraphs_info(all_mechanisms=True)",
        package: "bittensor",
        rpc_family: "subnetInfo",
        version: "10.4.0",
      },
      overlays: "registry/subnets",
    },
    subnets_without_official_surface: 13,
    surface_count: 3493,
  },
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
      // z.toJSONSchema()'s return type declares `properties` as optional (#8075).
      Object.keys(GET_BUILD_MCP_TOOL.inputSchema.properties ?? {}),
      [],
    );
    assert.ok(new Ajv2020({ strict: false }).compile(GET_BUILD_OUTPUT_SCHEMA));
  });

  test("SAMPLE_BUILD validates against GET_BUILD_OUTPUT_SCHEMA", () => {
    const validate = new Ajv2020({ strict: false }).compile(
      GET_BUILD_OUTPUT_SCHEMA,
    );
    assertValid(validate, SAMPLE_BUILD);
  });

  test("MCP server exports wire get_build", () => {
    assert.match(MCP_INSTRUCTIONS, /get_build/);
    const tool = MCP_TOOLS.find((t) => t.name === "get_build");
    assert.ok(tool);
    assert.equal(tool.title, GET_BUILD_MCP_TOOL.title);
  });
});
