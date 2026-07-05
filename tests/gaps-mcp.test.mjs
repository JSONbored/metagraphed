import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import * as listQuery from "../workers/list-query.mjs";
import {
  GAPS_ARTIFACT,
  LIST_GAPS_INSTRUCTIONS,
  LIST_GAPS_MCP_TOOL,
  LIST_GAPS_OUTPUT_SCHEMA,
  gapsMcpError,
  gapsQueryUrl,
  loadGapsList,
} from "../src/gaps-mcp.mjs";
import {
  MCP_INSTRUCTIONS,
  MCP_SERVER_VERSION,
  MCP_TOOLS,
} from "../src/mcp-server.mjs";

const SAMPLE_BLOB = {
  generated_at: "2026-07-01T00:00:00.000Z",
  notes: "test",
  gaps: [
    {
      netuid: 7,
      name: "Allways",
      coverage_level: "probed",
      curation_level: "maintainer-reviewed",
      gap_count: 2,
    },
    {
      netuid: 31,
      name: "Candles",
      coverage_level: "manifested",
      curation_level: "adapter-backed",
      gap_count: 5,
    },
  ],
};

function readArtifact(_env, path) {
  if (path === GAPS_ARTIFACT) {
    return Promise.resolve({ ok: true, data: SAMPLE_BLOB });
  }
  return Promise.resolve({ ok: false, code: "artifact_not_found" });
}

describe("gaps-mcp", () => {
  test("gapsMcpError is shaped for MCP toolError handling", () => {
    const err = gapsMcpError("invalid_params", "bad sort");
    assert.equal(err.code, "invalid_params");
    assert.equal(err.toolError, true);
  });

  test("gapsQueryUrl validates netuid, filters, and cursor", () => {
    const url = gapsQueryUrl({
      netuid: 7,
      coverage_level: "probed",
      curation_level: "adapter-backed",
      sort: "gap_count",
      order: "desc",
      limit: 10,
      cursor: 5,
    });
    assert.equal(url.searchParams.get("netuid"), "7");
    assert.equal(url.searchParams.get("coverage_level"), "probed");
    assert.equal(url.searchParams.get("curation_level"), "adapter-backed");
    assert.equal(url.searchParams.get("sort"), "gap_count");
    assert.equal(url.searchParams.get("limit"), "10");
    assert.equal(url.searchParams.get("cursor"), "5");
  });

  test("gapsQueryUrl rejects invalid coverage_level", () => {
    assert.throws(
      () => gapsQueryUrl({ coverage_level: "bogus" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("gapsQueryUrl rejects invalid curation_level", () => {
    assert.throws(
      () => gapsQueryUrl({ curation_level: "bogus" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("gapsQueryUrl rejects invalid netuid", () => {
    assert.throws(
      () => gapsQueryUrl({ netuid: -1 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("gapsQueryUrl rejects empty fields projection", () => {
    assert.throws(
      () => gapsQueryUrl({ fields: "   " }),
      (err) => err.code === "invalid_params",
    );
  });

  test("gapsQueryUrl rejects negative cursor", () => {
    assert.throws(
      () => gapsQueryUrl({ cursor: -1 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("gapsQueryUrl rejects non-string fields", () => {
    assert.throws(
      () => gapsQueryUrl({ fields: 42 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("gapsQueryUrl trims and forwards a fields projection", () => {
    const url = gapsQueryUrl({ fields: " netuid,gap_count " });
    assert.equal(url.searchParams.get("fields"), "netuid,gap_count");
  });

  test("gapsQueryUrl clamps a non-numeric limit to the default", () => {
    const url = gapsQueryUrl({ limit: "lots" });
    assert.equal(url.searchParams.get("limit"), "50");
  });

  test("gapsQueryUrl clamps a sub-minimum numeric limit to the default", () => {
    const url = gapsQueryUrl({ limit: 0 });
    assert.equal(url.searchParams.get("limit"), "50");
  });

  test("gapsQueryUrl clamps limit above the MCP maximum", () => {
    const url = gapsQueryUrl({ limit: 500 });
    assert.equal(url.searchParams.get("limit"), "100");
  });

  test("gapsQueryUrl rejects a fractional netuid", () => {
    assert.throws(
      () => gapsQueryUrl({ netuid: 1.5 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("loadGapsList returns filtered rows with pagination meta", async () => {
    const out = await loadGapsList({ env: {}, readArtifact }, { netuid: 7 });
    assert.equal(out.returned, 1);
    assert.equal(out.gaps[0].netuid, 7);
    assert.equal(out.gaps[0].gap_count, 2);
  });

  test("loadGapsList sorts and pages the collection", async () => {
    const out = await loadGapsList(
      { env: {}, readArtifact },
      { sort: "gap_count", order: "desc", limit: 1 },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.total, 2);
    assert.equal(out.gaps[0].netuid, 31);
    assert.equal(out.next_cursor, 1);
  });

  test("loadGapsList uses an injected readArtifact dep", async () => {
    const out = await loadGapsList(
      { env: {}, readArtifact: async () => ({ ok: false }) },
      {},
      {
        readArtifact: async () => ({
          ok: true,
          data: { gaps: [{ netuid: 0 }] },
        }),
      },
    );
    assert.equal(out.gaps[0].netuid, 0);
  });

  test("loadGapsList maps artifact_not_found to not_found", async () => {
    await assert.rejects(
      () =>
        loadGapsList(
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

  test("loadGapsList surfaces other artifact failures", async () => {
    await assert.rejects(
      () =>
        loadGapsList(
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
        err.code === "artifact_timeout" && /gaps\.json/.test(err.message),
    );
  });

  test("loadGapsList rejects invalid list-query params from REST parity", async () => {
    await assert.rejects(
      () => loadGapsList({ env: {}, readArtifact }, { fields: "not_a_column" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("loadGapsList projects row fields when requested", async () => {
    const out = await loadGapsList(
      { env: {}, readArtifact },
      { fields: "netuid,gap_count", limit: 1 },
    );
    assert.deepEqual(out.gaps[0], { netuid: 7, gap_count: 2 });
  });

  test("loadGapsList omits nullable artifact metadata when absent", async () => {
    const out = await loadGapsList(
      {
        env: {},
        readArtifact: async () => ({
          ok: true,
          data: { gaps: [{ netuid: 0 }] },
        }),
      },
      {},
    );
    assert.equal(out.generated_at, null);
    assert.equal(out.notes, null);
  });

  test("loadGapsList treats a non-array gaps key as empty", async () => {
    const out = await loadGapsList(
      {
        env: {},
        readArtifact: async () => ({
          ok: true,
          data: { gaps: null },
        }),
      },
      {},
    );
    assert.deepEqual(out.gaps, []);
    assert.equal(out.total, 0);
  });

  test("loadGapsList falls back when pagination meta is absent", async () => {
    const spy = vi.spyOn(listQuery, "applyQueryFilters").mockReturnValue({
      data: { gaps: [{ netuid: 9 }, { netuid: 10 }] },
      meta: {},
    });
    try {
      const out = await loadGapsList({ env: {}, readArtifact }, {});
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

  test("loadGapsList rejects a malformed artifact payload", async () => {
    await assert.rejects(
      () =>
        loadGapsList(
          {
            env: {},
            readArtifact: async () => ({ ok: true, data: null }),
          },
          {},
        ),
      (err) => err.code === "not_found",
    );
  });

  test("loadGapsList defaults code when the read result is bare", async () => {
    await assert.rejects(
      () =>
        loadGapsList(
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
    assert.equal(LIST_GAPS_MCP_TOOL.name, "list_gaps");
    assert.match(LIST_GAPS_INSTRUCTIONS, /list_gaps/);
    assert.ok(new Ajv2020({ strict: false }).compile(LIST_GAPS_OUTPUT_SCHEMA));
  });

  test("MCP server exports wire list_gaps at the bumped SemVer", () => {
    assert.equal(MCP_SERVER_VERSION, "1.63.0");
    assert.match(MCP_INSTRUCTIONS, /list_gaps/);
    const tool = MCP_TOOLS.find((t) => t.name === "list_gaps");
    assert.ok(tool);
    assert.equal(tool.title, "List subnet interface gaps");
  });
});
