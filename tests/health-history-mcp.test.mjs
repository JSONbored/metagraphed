import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import { latestArtifactDate } from "../scripts/lib.mjs";
import * as healthHistoryMcp from "../src/health-history-mcp.mjs";
import * as listQuery from "../workers/list-query.mjs";
import {
  GET_HEALTH_HISTORY_INSTRUCTIONS,
  GET_HEALTH_HISTORY_MCP_TOOL,
  GET_HEALTH_HISTORY_OUTPUT_SCHEMA,
  healthHistoryMcpError,
  healthHistoryQueryUrl,
  loadHealthHistory,
} from "../src/health-history-mcp.mjs";
import {
  MCP_INSTRUCTIONS,
  MCP_SERVER_VERSION,
  MCP_TOOLS,
} from "../src/mcp-server.mjs";

const HISTORY_DATE = await latestArtifactDate("health/history");
const SURFACE_ROW = {
  netuid: 7,
  surface_id: "sn-7-example",
  kind: "openapi",
  provider: "allways",
  status: "ok",
  classification: "live",
  latency_ms: 120,
};

const HISTORY_BLOB = {
  date: HISTORY_DATE || "2026-06-06",
  summary: { incident_count: 0, surface_count: 2 },
  surfaces: [
    SURFACE_ROW,
    { ...SURFACE_ROW, netuid: 1, surface_id: "sn-1-example" },
  ],
};

function makeCtx() {
  return { env: {} };
}

function makeDeps({ blob = HISTORY_BLOB, artifact = blob } = {}) {
  return {
    readArtifact: async (_ctx, path) => {
      if (artifact == null) return null;
      if (path.endsWith(`${blob.date}.json`)) return artifact;
      return null;
    },
  };
}

describe("health-history-mcp — healthHistoryQueryUrl", () => {
  test("maps health-surfaces list-query args onto the internal URL", () => {
    const url = healthHistoryQueryUrl({
      netuid: 7,
      kind: "openapi",
      provider: "allways",
      status: "ok",
      classification: "live",
      sort: "latency_ms",
      order: "desc",
      fields: "netuid,surface_id",
      limit: 25,
      cursor: 1,
    });
    assert.equal(url.searchParams.get("netuid"), "7");
    assert.equal(url.searchParams.get("kind"), "openapi");
    assert.equal(url.searchParams.get("provider"), "allways");
    assert.equal(url.searchParams.get("status"), "ok");
    assert.equal(url.searchParams.get("classification"), "live");
    assert.equal(url.searchParams.get("sort"), "latency_ms");
    assert.equal(url.searchParams.get("order"), "desc");
    assert.equal(url.searchParams.get("fields"), "netuid,surface_id");
    assert.equal(url.searchParams.get("limit"), "25");
    assert.equal(url.searchParams.get("cursor"), "1");
  });

  test("rejects invalid netuid, cursor, and malformed enums", () => {
    for (const [args, pattern] of [
      [{ netuid: -1 }, /netuid must be a non-negative integer/],
      [{ cursor: -1 }, /cursor must be a non-negative integer/],
      [{ status: "alive" }, /must be one of:/],
      [{ provider: "   " }, /must be a non-empty string/],
      [{ fields: 123 }, /must be a non-empty string/],
    ]) {
      assert.throws(
        () => healthHistoryQueryUrl(args),
        (err) => {
          assert.equal(err.healthHistoryMcp, true);
          assert.equal(err.code, "invalid_params");
          assert.match(err.message, pattern);
          return true;
        },
      );
    }
  });

  test("clamps a non-numeric limit to the default", () => {
    const url = healthHistoryQueryUrl({ limit: "50" });
    assert.equal(url.searchParams.get("limit"), "100");
  });

  test("clamps zero and negative numeric limits to the default", () => {
    assert.equal(
      healthHistoryQueryUrl({ limit: 0 }).searchParams.get("limit"),
      "100",
    );
    assert.equal(
      healthHistoryQueryUrl({ limit: -5 }).searchParams.get("limit"),
      "100",
    );
  });

  test("accepts a valid cursor and maps every optional filter", () => {
    const url = healthHistoryQueryUrl({
      kind: "openapi",
      provider: "allways",
      status: "ok",
      classification: "live",
      order: "desc",
      fields: "netuid,surface_id",
      cursor: 0,
    });
    assert.equal(url.searchParams.get("kind"), "openapi");
    assert.equal(url.searchParams.get("provider"), "allways");
    assert.equal(url.searchParams.get("status"), "ok");
    assert.equal(url.searchParams.get("classification"), "live");
    assert.equal(url.searchParams.get("order"), "desc");
    assert.equal(url.searchParams.get("fields"), "netuid,surface_id");
    assert.equal(url.searchParams.get("cursor"), "0");
  });

  test("rejects non-string optional string arguments", () => {
    assert.throws(
      () => healthHistoryQueryUrl({ provider: 123 }),
      /provider.*must be a non-empty string/,
    );
  });

  test("rejects invalid kind enums", () => {
    assert.throws(
      () => healthHistoryQueryUrl({ kind: "not-a-kind" }),
      /kind.*must be one of:/,
    );
  });
});

describe("health-history-mcp — loadHealthHistory", () => {
  test("rejects malformed dates before artifact I/O", async () => {
    await assert.rejects(
      () =>
        loadHealthHistory(
          makeCtx(),
          { date: "June" },
          makeDeps({ artifact: null }),
        ),
      /date must be a YYYY-MM-DD day/,
    );
  });

  test("applies list-query filters over a dated snapshot", async () => {
    const out = await loadHealthHistory(
      makeCtx(),
      { date: HISTORY_BLOB.date, netuid: 7, limit: 10 },
      makeDeps(),
    );
    assert.equal(out.date, HISTORY_BLOB.date);
    assert.equal(out.surfaces.length, 1);
    assert.equal(out.surfaces[0].netuid, 7);
    assert.equal(typeof out.summary.incident_count, "number");
  });

  test("returns not_found when the dated artifact is absent", async () => {
    await assert.rejects(
      () =>
        loadHealthHistory(
          makeCtx(),
          { date: HISTORY_BLOB.date },
          makeDeps({ artifact: null }),
        ),
      (err) => {
        assert.equal(err.healthHistoryMcp, true);
        assert.equal(err.code, "not_found");
        assert.match(err.message, /No health-history snapshot/);
        return true;
      },
    );
  });

  test("surfaces invalid_params from list-query validation", async () => {
    await assert.rejects(
      () =>
        loadHealthHistory(
          makeCtx(),
          { date: HISTORY_BLOB.date, fields: "netuid,not_a_field" },
          makeDeps(),
        ),
      (err) => {
        assert.equal(err.healthHistoryMcp, true);
        assert.equal(err.code, "invalid_params");
        return true;
      },
    );
  });

  test("pages with limit and echoes next_cursor when more rows remain", async () => {
    const out = await loadHealthHistory(
      makeCtx(),
      {
        date: HISTORY_BLOB.date,
        limit: 1,
        sort: "netuid",
        order: "asc",
      },
      makeDeps(),
    );
    assert.equal(out.returned, 1);
    assert.equal(out.total, 2);
    assert.equal(out.limit, 1);
    assert.equal(out.next_cursor, 1);
    assert.equal(out.sort, "netuid");
    assert.equal(out.order, "asc");
  });

  test("defaults pagination totals when the list-query meta omits page fields", async () => {
    const spy = vi.spyOn(listQuery, "applyQueryFilters").mockReturnValue({
      data: { surfaces: [SURFACE_ROW] },
      meta: {},
    });
    try {
      const out = await loadHealthHistory(
        makeCtx(),
        { date: HISTORY_BLOB.date },
        makeDeps(),
      );
      assert.equal(out.surfaces.length, 1);
      assert.equal(out.total, 1);
      assert.equal(out.returned, 1);
      assert.equal(out.limit, 1);
      assert.equal(out.cursor, 0);
      assert.equal(out.next_cursor, null);
      assert.equal(out.sort, null);
      assert.equal(out.order, null);
      assert.equal(out.date, HISTORY_BLOB.date);
      assert.equal(out.summary, null);
    } finally {
      spy.mockRestore();
    }
  });

  test("falls back when list-query data omits date, summary, and surface rows", async () => {
    const spy = vi.spyOn(listQuery, "applyQueryFilters").mockReturnValue({
      data: { surfaces: null },
      meta: { pagination: { total: 0, returned: 0, limit: 0, cursor: 0 } },
    });
    try {
      const out = await loadHealthHistory(
        makeCtx(),
        { date: HISTORY_BLOB.date },
        makeDeps(),
      );
      assert.deepEqual(out.surfaces, []);
      assert.equal(out.date, HISTORY_BLOB.date);
      assert.equal(out.summary, null);
      assert.equal(out.total, 0);
      assert.equal(out.returned, 0);
      assert.equal(out.limit, 0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("health-history-mcp — MCP metadata", () => {
  test("tool metadata and output schema compile", () => {
    assert.equal(GET_HEALTH_HISTORY_MCP_TOOL.name, "get_health_history");
    assert.match(GET_HEALTH_HISTORY_INSTRUCTIONS, /get_health_history/);
    assert.ok(
      new Ajv2020({ strict: false }).compile(GET_HEALTH_HISTORY_OUTPUT_SCHEMA),
    );
  });

  test("MCP server exports wire get_health_history at the bumped SemVer", () => {
    assert.equal(MCP_SERVER_VERSION, "1.25.0");
    assert.match(MCP_INSTRUCTIONS, /get_health_history/);
    const tool = MCP_TOOLS.find((t) => t.name === "get_health_history");
    assert.ok(tool?.handler);
    assert.equal(tool.title, GET_HEALTH_HISTORY_MCP_TOOL.title);
  });

  test("get_health_history handler maps healthHistoryMcp loader errors", async () => {
    const tool = MCP_TOOLS.find((t) => t.name === "get_health_history");
    const err = healthHistoryMcpError("invalid_params", "bad filter");
    const spy = vi
      .spyOn(healthHistoryMcp, "loadHealthHistory")
      .mockRejectedValue(err);
    try {
      await assert.rejects(
        () => tool.handler({ date: HISTORY_BLOB.date }, { env: {} }),
        (thrown) => {
          assert.equal(thrown.toolError, true);
          assert.equal(thrown.code, "invalid_params");
          assert.match(thrown.message, /bad filter/);
          return true;
        },
      );
    } finally {
      spy.mockRestore();
    }
  });

  test("get_health_history handler rethrows unexpected loader failures", async () => {
    const tool = MCP_TOOLS.find((t) => t.name === "get_health_history");
    await assert.rejects(
      () =>
        tool.handler(
          { date: HISTORY_BLOB.date },
          {
            env: {},
            readArtifact: async () => {
              throw new Error("kaboom");
            },
          },
        ),
      /kaboom/,
    );
  });
});
