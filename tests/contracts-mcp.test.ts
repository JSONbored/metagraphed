import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  CONTRACTS_ARTIFACT,
  GET_CONTRACTS_INSTRUCTIONS,
  GET_CONTRACTS_MCP_TOOL,
  GET_CONTRACTS_OUTPUT_SCHEMA,
  contractsToolError,
  loadContracts,
} from "../src/contracts-mcp.ts";
import { MCP_INSTRUCTIONS, MCP_TOOLS } from "../src/mcp-server.ts";
import type { StorageReadResult } from "../workers/storage.ts";
import { mockEnv, type Row } from "./row-type.ts";

type ReadArtifact = (env: Env, path: string) => Promise<StorageReadResult>;

const SAMPLE_CONTRACTS = {
  schema_version: 1,
  contract_version: "2026-07-03.2",
  generated_at: "2026-07-01T00:00:00.000Z",
  name: "Metagraphed public backend artifact contract",
  base_path: "/metagraph",
  primary_domain: "api.metagraph.sh",
  openapi_url: "/metagraph/openapi.json",
  type_definitions_url: "/metagraph/types.d.ts",
  notes: ["Native Bittensor chain data is canonical."],
  artifacts: [
    {
      id: "contracts",
      path: "/metagraph/contracts.json",
      storage_tier: "dual",
    },
  ],
};

describe("contracts-mcp", () => {
  test("contractsToolError is shaped for MCP toolError handling", () => {
    const err = contractsToolError("not_found", "missing");
    assert.equal(err.code, "not_found");
    assert.equal(err.toolError, true);
    assert.equal(err.message, "missing");
  });

  test("loadContracts returns the baked artifact payload", async () => {
    const ctx = {
      env: mockEnv(),
      readArtifact: (async (_env: Env, path: string) => ({
        ok: true,
        data: path === CONTRACTS_ARTIFACT ? SAMPLE_CONTRACTS : null,
      })) as ReadArtifact,
    };
    const out = (await loadContracts(ctx)) as Row;
    assert.equal(out.schema_version, 1);
    assert.equal(out.artifacts.length, 1);
    assert.equal(out.artifacts[0].id, "contracts");
  });

  test("loadContracts uses an injected readArtifact dep", async () => {
    const out = (await loadContracts(
      {
        env: mockEnv(),
        readArtifact: (async () => ({ ok: false })) as unknown as ReadArtifact,
      },
      {
        readArtifact: (async () => ({
          ok: true,
          data: { schema_version: 1, artifacts: [] },
        })) as unknown as ReadArtifact,
      },
    )) as Row;
    assert.deepEqual(out.artifacts, []);
  });

  test("loadContracts maps artifact_not_found to not_found", async () => {
    const ctx = {
      env: mockEnv(),
      readArtifact: (async () => ({
        ok: false,
        code: "artifact_not_found",
      })) as unknown as ReadArtifact,
    };
    await assert.rejects(
      () => loadContracts(ctx),
      (err: Row) =>
        err.code === "not_found" &&
        err.toolError === true &&
        /unavailable in this environment/.test(err.message),
    );
  });

  test("loadContracts surfaces other artifact failures with the path", async () => {
    const ctx = {
      env: mockEnv(),
      readArtifact: (async () => ({
        ok: false,
        code: "artifact_timeout",
      })) as unknown as ReadArtifact,
    };
    await assert.rejects(
      () => loadContracts(ctx),
      (err: Row) =>
        err.code === "artifact_timeout" && /contracts\.json/.test(err.message),
    );
  });

  test("loadContracts defaults code when the read result is bare", async () => {
    const ctx = {
      env: mockEnv(),
      readArtifact: (async () => ({ ok: false })) as unknown as ReadArtifact,
    };
    await assert.rejects(
      () => loadContracts(ctx),
      (err: Row) => err.code === "artifact_unavailable",
    );
  });

  test("MCP tool metadata and outputSchema compile", () => {
    assert.equal(GET_CONTRACTS_MCP_TOOL.name, "get_contracts");
    assert.match(GET_CONTRACTS_INSTRUCTIONS, /get_contracts/);
    assert.deepEqual(
      Object.keys(GET_CONTRACTS_MCP_TOOL.inputSchema.properties),
      [],
    );
    assert.ok(
      new Ajv2020({ strict: false }).compile(GET_CONTRACTS_OUTPUT_SCHEMA),
    );
  });

  test("SAMPLE_CONTRACTS validates against GET_CONTRACTS_OUTPUT_SCHEMA", () => {
    const validate = new Ajv2020({ strict: false }).compile(
      GET_CONTRACTS_OUTPUT_SCHEMA,
    );
    assert.ok(validate(SAMPLE_CONTRACTS));
  });

  test("MCP server exports wire get_contracts", () => {
    assert.match(MCP_INSTRUCTIONS, /get_contracts/);
    const tool = MCP_TOOLS.find((t) => t.name === "get_contracts");
    assert.ok(tool);
    assert.equal(tool.title, GET_CONTRACTS_MCP_TOOL.title);
  });
});
