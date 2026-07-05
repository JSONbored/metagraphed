import assert from "node:assert/strict";
import { describe, test } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import {
  GET_ADAPTER_INSTRUCTIONS,
  GET_ADAPTER_MCP_TOOL,
  GET_ADAPTER_OUTPUT_SCHEMA,
  adapterArtifactPath,
  adapterToolError,
  loadAdapter,
  parseAdapterSlug,
} from "../src/adapters-mcp.mjs";
import {
  MCP_INSTRUCTIONS,
  MCP_SERVER_VERSION,
  MCP_TOOLS,
} from "../src/mcp-server.mjs";

const SAMPLE_ADAPTER = {
  schema_version: 1,
  contract_version: "2026-07-01",
  generated_at: "2026-07-01T00:00:00.000Z",
  slug: "gittensor",
  subnet: "gittensor",
  netuid: 74,
  notes: ["test"],
  snapshot: { status: "captured", adapter_kind: "generic-openapi" },
  extensions: { generic_adapter: { kind: "generic-openapi" } },
};

describe("adapters-mcp", () => {
  test("adapterArtifactPath builds the adapter artifact key", () => {
    assert.equal(
      adapterArtifactPath("gittensor"),
      "/metagraph/adapters/gittensor.json",
    );
  });

  test("adapterToolError is shaped for MCP toolError handling", () => {
    const err = adapterToolError("not_found", "missing");
    assert.equal(err.code, "not_found");
    assert.equal(err.toolError, true);
    assert.equal(err.message, "missing");
  });

  test("parseAdapterSlug validates and normalizes slug input", () => {
    assert.equal(parseAdapterSlug({ slug: " sn-64 " }), "sn-64");
  });

  test("parseAdapterSlug rejects empty slug", () => {
    assert.throws(
      () => parseAdapterSlug({ slug: "   " }),
      (err) => err.code === "invalid_params",
    );
  });

  test("parseAdapterSlug rejects uppercase slug", () => {
    assert.throws(
      () => parseAdapterSlug({ slug: "Gittensor" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("parseAdapterSlug rejects slug with underscores", () => {
    assert.throws(
      () => parseAdapterSlug({ slug: "has_underscore" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("parseAdapterSlug rejects missing slug", () => {
    assert.throws(
      () => parseAdapterSlug({}),
      (err) => err.code === "invalid_params",
    );
  });

  test("loadAdapter returns the baked artifact payload", async () => {
    const ctx = {
      env: {},
      readArtifact: async (_env, path) => ({
        ok: true,
        data:
          path === "/metagraph/adapters/gittensor.json" ? SAMPLE_ADAPTER : null,
      }),
    };
    const out = await loadAdapter(ctx, { slug: "gittensor" });
    assert.equal(out.slug, "gittensor");
    assert.equal(out.netuid, 74);
    assert.equal(out.snapshot.status, "captured");
  });

  test("loadAdapter uses an injected readArtifact dep", async () => {
    const out = await loadAdapter(
      { env: {}, readArtifact: async () => ({ ok: false }) },
      { slug: "solo" },
      {
        readArtifact: async () => ({
          ok: true,
          data: { schema_version: 1, slug: "solo", snapshot: {} },
        }),
      },
    );
    assert.equal(out.slug, "solo");
  });

  test("loadAdapter maps artifact_not_found to not_found", async () => {
    const ctx = {
      env: {},
      readArtifact: async () => ({
        ok: false,
        code: "artifact_not_found",
      }),
    };
    await assert.rejects(
      () => loadAdapter(ctx, { slug: "missing" }),
      (err) =>
        err.code === "not_found" &&
        /No adapter snapshot exists for slug 'missing'/.test(err.message),
    );
  });

  test("loadAdapter surfaces other artifact failures with the path", async () => {
    const ctx = {
      env: {},
      readArtifact: async () => ({
        ok: false,
        code: "artifact_timeout",
      }),
    };
    await assert.rejects(
      () => loadAdapter(ctx, { slug: "gittensor" }),
      (err) =>
        err.code === "artifact_timeout" &&
        /adapters\/gittensor\.json/.test(err.message),
    );
  });

  test("loadAdapter defaults code when the read result is bare", async () => {
    const ctx = {
      env: {},
      readArtifact: async () => ({ ok: false }),
    };
    await assert.rejects(
      () => loadAdapter(ctx, { slug: "gittensor" }),
      (err) => err.code === "artifact_unavailable",
    );
  });

  test("loadAdapter rejects a malformed artifact payload", async () => {
    const ctx = {
      env: {},
      readArtifact: async () => ({ ok: true, data: null }),
    };
    await assert.rejects(
      () => loadAdapter(ctx, { slug: "gittensor" }),
      (err) => err.code === "not_found",
    );
  });

  test("MCP tool metadata and outputSchema compile", () => {
    assert.equal(GET_ADAPTER_MCP_TOOL.name, "get_adapter");
    assert.match(GET_ADAPTER_INSTRUCTIONS, /get_adapter/);
    assert.deepEqual(Object.keys(GET_ADAPTER_MCP_TOOL.inputSchema.properties), [
      "slug",
    ]);
    assert.ok(
      new Ajv2020({ strict: false }).compile(GET_ADAPTER_OUTPUT_SCHEMA),
    );
  });

  test("SAMPLE_ADAPTER validates against GET_ADAPTER_OUTPUT_SCHEMA", () => {
    const validate = new Ajv2020({ strict: false }).compile(
      GET_ADAPTER_OUTPUT_SCHEMA,
    );
    assert.ok(validate(SAMPLE_ADAPTER));
  });

  test("MCP server exports wire get_adapter at the bumped SemVer", () => {
    assert.equal(MCP_SERVER_VERSION, "1.72.0");
    assert.match(MCP_INSTRUCTIONS, /get_adapter/);
    const tool = MCP_TOOLS.find((t) => t.name === "get_adapter");
    assert.ok(tool);
    assert.equal(tool.title, GET_ADAPTER_MCP_TOOL.title);
  });
});
