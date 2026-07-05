import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import * as listQuery from "../workers/list-query.mjs";
import {
  CANDIDATES_ARTIFACT,
  LIST_CANDIDATES_INSTRUCTIONS,
  LIST_CANDIDATES_MCP_TOOL,
  LIST_CANDIDATES_OUTPUT_SCHEMA,
  candidatesMcpError,
  candidatesQueryUrl,
  loadCandidatesList,
} from "../src/candidates-mcp.mjs";
import { MCP_INSTRUCTIONS, MCP_TOOLS } from "../src/mcp-server.mjs";

const SAMPLE_BLOB = {
  generated_at: "2026-07-01T00:00:00.000Z",
  schema_version: 1,
  candidates: [
    {
      netuid: 7,
      kind: "openapi",
      provider: "datura",
      state: "verified",
    },
    {
      netuid: 7,
      kind: "subnet-api",
      provider: "chutes",
      state: "schema-valid",
    },
    {
      netuid: 12,
      kind: "openapi",
      provider: "datura",
      state: "stale",
    },
  ],
};

function readArtifact(_env, path) {
  if (path === CANDIDATES_ARTIFACT) {
    return Promise.resolve({ ok: true, data: SAMPLE_BLOB });
  }
  return Promise.resolve({ ok: false, code: "artifact_not_found" });
}

describe("candidates-mcp", () => {
  test("candidatesMcpError is shaped for MCP toolError handling", () => {
    const err = candidatesMcpError("invalid_params", "bad kind");
    assert.equal(err.code, "invalid_params");
    assert.equal(err.toolError, true);
  });

  test("candidatesQueryUrl validates filters and cursor", () => {
    const url = candidatesQueryUrl({
      netuid: 7,
      kind: "openapi",
      provider: "datura",
      state: "verified",
      sort: "provider",
      order: "asc",
      fields: "netuid,provider",
      limit: 10,
      cursor: 5,
    });
    assert.equal(url.searchParams.get("netuid"), "7");
    assert.equal(url.searchParams.get("kind"), "openapi");
    assert.equal(url.searchParams.get("provider"), "datura");
    assert.equal(url.searchParams.get("state"), "verified");
    assert.equal(url.searchParams.get("sort"), "provider");
    assert.equal(url.searchParams.get("limit"), "10");
    assert.equal(url.searchParams.get("cursor"), "5");
  });

  test("candidatesQueryUrl rejects invalid netuid and kind", () => {
    assert.throws(
      () => candidatesQueryUrl({ netuid: -1 }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => candidatesQueryUrl({ kind: "not-a-kind" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("candidatesQueryUrl rejects empty provider and invalid state", () => {
    assert.throws(
      () => candidatesQueryUrl({ provider: "   " }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => candidatesQueryUrl({ state: "not-a-state" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("candidatesQueryUrl rejects invalid sort and order", () => {
    assert.throws(
      () => candidatesQueryUrl({ sort: "not_a_column" }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => candidatesQueryUrl({ order: "sideways" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("candidatesQueryUrl rejects non-string provider and invalid fields", () => {
    assert.throws(
      () => candidatesQueryUrl({ provider: 42 }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => candidatesQueryUrl({ fields: "   " }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => candidatesQueryUrl({ fields: 42 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("candidatesQueryUrl trims and forwards a fields projection", () => {
    const url = candidatesQueryUrl({ fields: " netuid,provider " });
    assert.equal(url.searchParams.get("fields"), "netuid,provider");
  });

  test("candidatesQueryUrl clamps a non-numeric limit to the default", () => {
    const url = candidatesQueryUrl({ limit: "lots" });
    assert.equal(url.searchParams.get("limit"), "50");
  });

  test("candidatesQueryUrl clamps a sub-minimum numeric limit to the default", () => {
    const url = candidatesQueryUrl({ limit: 0 });
    assert.equal(url.searchParams.get("limit"), "50");
  });

  test("candidatesQueryUrl rejects a fractional netuid and cursor", () => {
    assert.throws(
      () => candidatesQueryUrl({ netuid: 1.5 }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => candidatesQueryUrl({ cursor: 1.5 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("candidatesQueryUrl rejects negative cursor", () => {
    assert.throws(
      () => candidatesQueryUrl({ cursor: -1 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("candidatesQueryUrl clamps limit above the MCP maximum", () => {
    const url = candidatesQueryUrl({ limit: 500 });
    assert.equal(url.searchParams.get("limit"), "100");
  });

  test("loadCandidatesList returns filtered rows with pagination meta", async () => {
    const out = await loadCandidatesList(
      { env: {}, readArtifact },
      { provider: "chutes" },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.candidates[0].kind, "subnet-api");
  });

  test("loadCandidatesList sorts and pages the collection", async () => {
    const out = await loadCandidatesList(
      { env: {}, readArtifact },
      { sort: "provider", order: "desc", limit: 1 },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.total, 3);
    assert.equal(out.next_cursor, 1);
  });

  test("loadCandidatesList combines filters with AND semantics", async () => {
    const out = await loadCandidatesList(
      { env: {}, readArtifact },
      { netuid: 7, provider: "datura" },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.candidates[0].kind, "openapi");
  });

  test("loadCandidatesList uses an injected readArtifact dep", async () => {
    const out = await loadCandidatesList(
      { env: {}, readArtifact: async () => ({ ok: false }) },
      {},
      {
        readArtifact: async () => ({
          ok: true,
          data: {
            candidates: [{ netuid: 99, provider: "solo", state: "verified" }],
          },
        }),
      },
    );
    assert.equal(out.candidates[0].provider, "solo");
  });

  test("loadCandidatesList maps artifact_not_found to not_found", async () => {
    await assert.rejects(
      () =>
        loadCandidatesList(
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

  test("loadCandidatesList surfaces other artifact failures", async () => {
    await assert.rejects(
      () =>
        loadCandidatesList(
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
        err.code === "artifact_timeout" && /candidates\.json/.test(err.message),
    );
  });

  test("loadCandidatesList rejects invalid list-query params from REST parity", async () => {
    await assert.rejects(
      () =>
        loadCandidatesList(
          { env: {}, readArtifact },
          { fields: "not_a_column" },
        ),
      (err) => err.code === "invalid_params",
    );
  });

  test("loadCandidatesList projects row fields when requested", async () => {
    const out = await loadCandidatesList(
      { env: {}, readArtifact },
      { netuid: 7, provider: "datura", fields: "netuid,provider" },
    );
    assert.deepEqual(out.candidates[0], {
      netuid: 7,
      provider: "datura",
    });
  });

  test("loadCandidatesList omits nullable artifact metadata when absent", async () => {
    const out = await loadCandidatesList(
      {
        env: {},
        readArtifact: async () => ({
          ok: true,
          data: { candidates: [{ netuid: 7, provider: "solo" }] },
        }),
      },
      {},
    );
    assert.equal(out.generated_at, null);
    assert.equal(out.schema_version, null);
  });

  test("loadCandidatesList treats a non-array candidates key as empty", async () => {
    const out = await loadCandidatesList(
      {
        env: {},
        readArtifact: async () => ({
          ok: true,
          data: { candidates: null },
        }),
      },
      {},
    );
    assert.deepEqual(out.candidates, []);
    assert.equal(out.total, 0);
  });

  test("loadCandidatesList falls back when pagination meta is absent", async () => {
    const spy = vi.spyOn(listQuery, "applyQueryFilters").mockReturnValue({
      data: { candidates: [{ netuid: 1 }, { netuid: 2 }] },
      meta: {},
    });
    try {
      const out = await loadCandidatesList({ env: {}, readArtifact }, {});
      assert.equal(out.total, 2);
      assert.equal(out.returned, 2);
      assert.equal(out.limit, 2);
      assert.equal(out.cursor, 0);
      assert.equal(out.next_cursor, null);
      assert.equal(out.sort, null);
      assert.equal(out.order, null);
    } finally {
      spy.mockRestore();
    }
  });

  test("loadCandidatesList rejects a malformed artifact payload", async () => {
    await assert.rejects(
      () =>
        loadCandidatesList(
          {
            env: {},
            readArtifact: async () => ({ ok: true, data: null }),
          },
          {},
        ),
      (err) => err.code === "not_found",
    );
  });

  test("loadCandidatesList defaults code when the read result is bare", async () => {
    await assert.rejects(
      () =>
        loadCandidatesList(
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
    assert.equal(LIST_CANDIDATES_MCP_TOOL.name, "list_candidates");
    assert.match(LIST_CANDIDATES_INSTRUCTIONS, /list_candidates/);
    assert.ok(
      new Ajv2020({ strict: false }).compile(LIST_CANDIDATES_OUTPUT_SCHEMA),
    );
  });

  test("MCP server exports wire list_candidates", () => {
    assert.match(MCP_INSTRUCTIONS, /list_candidates/);
    const tool = MCP_TOOLS.find((t) => t.name === "list_candidates");
    assert.ok(tool);
    assert.equal(tool.title, "List unpromoted candidate surfaces");
  });
});
