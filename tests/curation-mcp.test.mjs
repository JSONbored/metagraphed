import assert from "node:assert/strict";
import { describe, test } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import {
  CURATION_ARTIFACT,
  LIST_CURATION_INSTRUCTIONS,
  LIST_CURATION_MCP_TOOL,
  LIST_CURATION_OUTPUT_SCHEMA,
  curationMcpError,
  curationQueryUrl,
  loadCurationList,
} from "../src/curation-mcp.mjs";
import {
  MCP_INSTRUCTIONS,
  MCP_SERVER_VERSION,
  MCP_TOOLS,
} from "../src/mcp-server.mjs";

const SAMPLE_BLOB = {
  generated_at: "2026-07-01T00:00:00.000Z",
  notes: "test",
  curation: [
    {
      netuid: 7,
      name: "Allways",
      coverage_level: "probed",
      curation_level: "verified",
    },
    {
      netuid: 31,
      name: "Candles",
      coverage_level: "manifested",
      curation_level: "adapter-backed",
    },
  ],
};

function readArtifact(_env, path) {
  if (path === CURATION_ARTIFACT) {
    return Promise.resolve({ ok: true, data: SAMPLE_BLOB });
  }
  return Promise.resolve({ ok: false, code: "artifact_not_found" });
}

describe("curation-mcp", () => {
  test("curationMcpError is shaped for MCP toolError handling", () => {
    const err = curationMcpError("invalid_params", "bad sort");
    assert.equal(err.code, "invalid_params");
    assert.equal(err.toolError, true);
  });

  test("curationQueryUrl validates netuid and cursor", () => {
    const url = curationQueryUrl({
      netuid: 7,
      coverage_level: "probed",
      sort: "netuid",
      order: "desc",
      limit: 10,
      cursor: 5,
    });
    assert.equal(url.searchParams.get("netuid"), "7");
    assert.equal(url.searchParams.get("coverage_level"), "probed");
    assert.equal(url.searchParams.get("sort"), "netuid");
    assert.equal(url.searchParams.get("limit"), "10");
    assert.equal(url.searchParams.get("cursor"), "5");
  });

  test("curationQueryUrl rejects invalid coverage_level", () => {
    assert.throws(
      () => curationQueryUrl({ coverage_level: "bogus" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("curationQueryUrl rejects invalid netuid", () => {
    assert.throws(
      () => curationQueryUrl({ netuid: -1 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("curationQueryUrl rejects empty fields projection", () => {
    assert.throws(
      () => curationQueryUrl({ fields: "   " }),
      (err) => err.code === "invalid_params",
    );
  });

  test("curationQueryUrl rejects negative cursor", () => {
    assert.throws(
      () => curationQueryUrl({ cursor: -1 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("loadCurationList returns filtered rows with pagination meta", async () => {
    const out = await loadCurationList(
      { env: {}, readArtifact },
      { netuid: 7 },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.curation[0].netuid, 7);
    assert.equal(out.curation[0].coverage_level, "probed");
  });

  test("loadCurationList sorts and pages the collection", async () => {
    const out = await loadCurationList(
      { env: {}, readArtifact },
      { sort: "netuid", order: "desc", limit: 1 },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.total, 2);
    assert.equal(out.curation[0].netuid, 31);
    assert.equal(out.next_cursor, 1);
  });

  test("loadCurationList uses an injected readArtifact dep", async () => {
    const out = await loadCurationList(
      { env: {}, readArtifact: async () => ({ ok: false }) },
      {},
      {
        readArtifact: async () => ({
          ok: true,
          data: { curation: [{ netuid: 0 }] },
        }),
      },
    );
    assert.equal(out.curation[0].netuid, 0);
  });

  test("loadCurationList maps artifact_not_found to not_found", async () => {
    await assert.rejects(
      () =>
        loadCurationList(
          {
            env: {},
            readArtifact: async () => ({
              ok: false,
              code: "artifact_not_found",
            }),
          },
          {},
        ),
      (err) => err.code === "not_found",
    );
  });

  test("loadCurationList surfaces other artifact failures", async () => {
    await assert.rejects(
      () =>
        loadCurationList(
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
        err.code === "artifact_timeout" && /curation\.json/.test(err.message),
    );
  });

  test("loadCurationList rejects invalid list-query params from REST parity", async () => {
    await assert.rejects(
      () =>
        loadCurationList({ env: {}, readArtifact }, { sort: "not_a_field" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("loadCurationList rejects a malformed artifact payload", async () => {
    await assert.rejects(
      () =>
        loadCurationList(
          {
            env: {},
            readArtifact: async () => ({ ok: true, data: null }),
          },
          {},
        ),
      (err) => err.code === "not_found",
    );
  });

  test("loadCurationList defaults code when the read result is bare", async () => {
    await assert.rejects(
      () =>
        loadCurationList(
          {
            env: {},
            readArtifact: async () => ({ ok: false }),
          },
          {},
        ),
      (err) => err.code === "artifact_unavailable",
    );
  });

  test("MCP tool metadata and outputSchema compile", () => {
    assert.equal(LIST_CURATION_MCP_TOOL.name, "list_curation");
    assert.match(LIST_CURATION_INSTRUCTIONS, /list_curation/);
    assert.ok(
      new Ajv2020({ strict: false }).compile(LIST_CURATION_OUTPUT_SCHEMA),
    );
  });

  test("MCP server exports wire list_curation at the bumped SemVer", () => {
    assert.equal(MCP_SERVER_VERSION, "1.22.0");
    assert.match(MCP_INSTRUCTIONS, /list_curation/);
    const tool = MCP_TOOLS.find((t) => t.name === "list_curation");
    assert.ok(tool);
    assert.equal(tool.title, "List subnet curation states");
  });
});
