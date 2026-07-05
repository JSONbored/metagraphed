import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import * as listQuery from "../workers/list-query.mjs";
import {
  COVERAGE_DEPTH_ARTIFACT,
  LIST_COVERAGE_DEPTH_INSTRUCTIONS,
  LIST_COVERAGE_DEPTH_MCP_TOOL,
  LIST_COVERAGE_DEPTH_OUTPUT_SCHEMA,
  coverageDepthMcpError,
  coverageDepthQueryUrl,
  loadCoverageDepthList,
} from "../src/coverage-depth-mcp.mjs";
import {
  MCP_INSTRUCTIONS,
  MCP_SERVER_VERSION,
  MCP_TOOLS,
} from "../src/mcp-server.mjs";

const SAMPLE_BLOB = {
  generated_at: "2026-07-01T00:00:00.000Z",
  notes: "test",
  rows: [
    {
      netuid: 7,
      slug: "allways",
      name: "Allways",
      tier: "machine-usable",
      score: 77,
      priority_score: 86,
      agent_status: "callable",
      blocker_level: "none",
      top_gap_codes: ["missing-fixture"],
      recommended_next_action: "capture a sanitized fixture",
    },
    {
      netuid: 31,
      slug: "recall",
      name: "Recall",
      tier: "missing-interface",
      score: 18,
      priority_score: 67,
      agent_status: "blocked",
      blocker_level: "missing-data",
      top_gap_codes: ["missing-callable-service"],
      recommended_next_action: "find an official callable surface",
    },
  ],
};

function readArtifact(_env, path) {
  if (path === COVERAGE_DEPTH_ARTIFACT) {
    return Promise.resolve({ ok: true, data: SAMPLE_BLOB });
  }
  return Promise.resolve({ ok: false, code: "artifact_not_found" });
}

describe("coverage-depth-mcp", () => {
  test("coverageDepthMcpError is shaped for MCP toolError handling", () => {
    const err = coverageDepthMcpError("invalid_params", "bad sort");
    assert.equal(err.code, "invalid_params");
    assert.equal(err.toolError, true);
  });

  test("coverageDepthQueryUrl validates filters, search, and cursor", () => {
    const url = coverageDepthQueryUrl({
      netuid: 7,
      tier: "machine-usable",
      agent_status: "callable",
      blocker_level: "none",
      q: "allways",
      sort: "priority_score",
      order: "desc",
      fields: "netuid,tier,score",
      limit: 10,
      cursor: 5,
    });
    assert.equal(url.searchParams.get("netuid"), "7");
    assert.equal(url.searchParams.get("tier"), "machine-usable");
    assert.equal(url.searchParams.get("agent_status"), "callable");
    assert.equal(url.searchParams.get("blocker_level"), "none");
    assert.equal(url.searchParams.get("q"), "allways");
    assert.equal(url.searchParams.get("sort"), "priority_score");
    assert.equal(url.searchParams.get("fields"), "netuid,tier,score");
    assert.equal(url.searchParams.get("limit"), "10");
    assert.equal(url.searchParams.get("cursor"), "5");
  });

  test("coverageDepthQueryUrl rejects invalid tier", () => {
    assert.throws(
      () => coverageDepthQueryUrl({ tier: "bogus" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("coverageDepthQueryUrl rejects invalid agent_status", () => {
    assert.throws(
      () => coverageDepthQueryUrl({ agent_status: "bogus" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("coverageDepthQueryUrl rejects invalid netuid", () => {
    assert.throws(
      () => coverageDepthQueryUrl({ netuid: -1 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("coverageDepthQueryUrl rejects negative cursor", () => {
    assert.throws(
      () => coverageDepthQueryUrl({ cursor: -1 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("coverageDepthQueryUrl rejects invalid agent_status", () => {
    assert.throws(
      () => coverageDepthQueryUrl({ agent_status: "bogus" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("coverageDepthQueryUrl rejects invalid blocker_level", () => {
    assert.throws(
      () => coverageDepthQueryUrl({ blocker_level: "bogus" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("coverageDepthQueryUrl rejects invalid sort", () => {
    assert.throws(
      () => coverageDepthQueryUrl({ sort: "bogus" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("coverageDepthQueryUrl rejects a fractional netuid", () => {
    assert.throws(
      () => coverageDepthQueryUrl({ netuid: 1.5 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("coverageDepthQueryUrl rejects empty q search", () => {
    assert.throws(
      () => coverageDepthQueryUrl({ q: "   " }),
      (err) => err.code === "invalid_params",
    );
  });

  test("coverageDepthQueryUrl rejects non-string fields", () => {
    assert.throws(
      () => coverageDepthQueryUrl({ fields: 42 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("coverageDepthQueryUrl rejects empty fields projection", () => {
    assert.throws(
      () => coverageDepthQueryUrl({ fields: "   " }),
      (err) => err.code === "invalid_params",
    );
  });

  test("coverageDepthQueryUrl trims and forwards a fields projection", () => {
    const url = coverageDepthQueryUrl({ fields: " netuid,tier " });
    assert.equal(url.searchParams.get("fields"), "netuid,tier");
  });

  test("coverageDepthQueryUrl clamps a non-numeric limit to the default", () => {
    const url = coverageDepthQueryUrl({ limit: "lots" });
    assert.equal(url.searchParams.get("limit"), "50");
  });

  test("coverageDepthQueryUrl clamps a sub-minimum numeric limit to the default", () => {
    const url = coverageDepthQueryUrl({ limit: 0 });
    assert.equal(url.searchParams.get("limit"), "50");
  });

  test("coverageDepthQueryUrl clamps limit above the MCP maximum", () => {
    const url = coverageDepthQueryUrl({ limit: 500 });
    assert.equal(url.searchParams.get("limit"), "100");
  });

  test("loadCoverageDepthList returns filtered rows with pagination meta", async () => {
    const out = await loadCoverageDepthList(
      { env: {}, readArtifact },
      { tier: "machine-usable" },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.rows[0].netuid, 7);
    assert.equal(out.rows[0].tier, "machine-usable");
  });

  test("loadCoverageDepthList sorts and pages the collection", async () => {
    const out = await loadCoverageDepthList(
      { env: {}, readArtifact },
      { sort: "priority_score", order: "desc", limit: 1 },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.total, 2);
    assert.equal(out.rows[0].netuid, 7);
    assert.equal(out.next_cursor, 1);
  });

  test("loadCoverageDepthList uses an injected readArtifact dep", async () => {
    const out = await loadCoverageDepthList(
      { env: {}, readArtifact: async () => ({ ok: false }) },
      {},
      {
        readArtifact: async () => ({
          ok: true,
          data: { rows: [{ netuid: 0 }] },
        }),
      },
    );
    assert.equal(out.rows[0].netuid, 0);
  });

  test("loadCoverageDepthList surfaces other artifact failures", async () => {
    await assert.rejects(
      () =>
        loadCoverageDepthList(
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
        /coverage-depth\.json/.test(err.message),
    );
  });

  test("loadCoverageDepthList preserves array notes from the artifact", async () => {
    const out = await loadCoverageDepthList(
      {
        env: {},
        readArtifact: async () => ({
          ok: true,
          data: {
            notes: ["advisory only"],
            rows: [{ netuid: 7 }],
          },
        }),
      },
      {},
    );
    assert.deepEqual(out.notes, ["advisory only"]);
  });

  test("loadCoverageDepthList omits nullable artifact metadata when absent", async () => {
    const out = await loadCoverageDepthList(
      {
        env: {},
        readArtifact: async () => ({
          ok: true,
          data: { rows: [{ netuid: 0 }] },
        }),
      },
      {},
    );
    assert.equal(out.generated_at, null);
    assert.equal(out.notes, null);
  });

  test("loadCoverageDepthList defaults code when the read result is bare", async () => {
    await assert.rejects(
      () =>
        loadCoverageDepthList(
          {
            env: {},
            readArtifact: async () => ({ ok: false }),
          },
          {},
        ),
      (err) => err.code === "artifact_unavailable",
    );
  });

  test("loadCoverageDepthList maps artifact_not_found to not_found", async () => {
    await assert.rejects(
      () =>
        loadCoverageDepthList(
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

  test("loadCoverageDepthList rejects invalid list-query params from REST parity", async () => {
    await assert.rejects(
      () =>
        loadCoverageDepthList(
          { env: {}, readArtifact },
          { fields: "not_a_column" },
        ),
      (err) => err.code === "invalid_params",
    );
  });

  test("loadCoverageDepthList projects row fields when requested", async () => {
    const out = await loadCoverageDepthList(
      { env: {}, readArtifact },
      { fields: "netuid,tier,score", limit: 1 },
    );
    assert.deepEqual(out.rows[0], {
      netuid: 7,
      tier: "machine-usable",
      score: 77,
    });
  });

  test("loadCoverageDepthList treats a non-array rows key as empty", async () => {
    const out = await loadCoverageDepthList(
      {
        env: {},
        readArtifact: async () => ({
          ok: true,
          data: { rows: null },
        }),
      },
      {},
    );
    assert.deepEqual(out.rows, []);
    assert.equal(out.total, 0);
  });

  test("loadCoverageDepthList falls back when pagination meta is absent", async () => {
    const spy = vi.spyOn(listQuery, "applyQueryFilters").mockReturnValue({
      data: { rows: [{ netuid: 9 }, { netuid: 10 }] },
      meta: {},
    });
    try {
      const out = await loadCoverageDepthList({ env: {}, readArtifact }, {});
      assert.equal(out.total, 2);
      assert.equal(out.returned, 2);
      assert.equal(out.limit, 2);
      assert.equal(out.cursor, 0);
      assert.equal(out.next_cursor, null);
    } finally {
      spy.mockRestore();
    }
  });

  test("loadCoverageDepthList rejects a malformed artifact payload", async () => {
    await assert.rejects(
      () =>
        loadCoverageDepthList(
          {
            env: {},
            readArtifact: async () => ({ ok: true, data: null }),
          },
          {},
        ),
      (err) => err.code === "not_found",
    );
  });

  test("MCP tool metadata and outputSchema compile", () => {
    assert.equal(LIST_COVERAGE_DEPTH_MCP_TOOL.name, "list_coverage_depth");
    assert.match(LIST_COVERAGE_DEPTH_INSTRUCTIONS, /list_coverage_depth/);
    assert.ok(
      new Ajv2020({ strict: false }).compile(LIST_COVERAGE_DEPTH_OUTPUT_SCHEMA),
    );
  });

  test("MCP server exports wire list_coverage_depth at the bumped SemVer", () => {
    assert.equal(MCP_SERVER_VERSION, "1.67.0");
    assert.match(MCP_INSTRUCTIONS, /list_coverage_depth/);
    const tool = MCP_TOOLS.find((t) => t.name === "list_coverage_depth");
    assert.ok(tool);
    assert.equal(tool.title, "List coverage-depth scorecard rows");
  });
});
