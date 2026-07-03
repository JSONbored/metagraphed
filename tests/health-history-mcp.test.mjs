import assert from "node:assert/strict";
import { describe, test } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import { latestArtifactDate } from "../scripts/lib.mjs";
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

function makeDeps({ blob = HISTORY_BLOB, missing = false } = {}) {
  return {
    readArtifact: async (_ctx, path) => {
      if (missing) {
        const err = healthHistoryMcpError("not_found", "missing");
        throw err;
      }
      if (path.endsWith(`${blob.date}.json`)) return blob;
      const err = healthHistoryMcpError("not_found", "missing");
      throw err;
    },
  };
}

describe("health-history-mcp — healthHistoryQueryUrl", () => {
  test("maps health-surfaces list-query args onto the internal URL", () => {
    const url = healthHistoryQueryUrl({
      netuid: 7,
      status: "ok",
      sort: "latency_ms",
      order: "desc",
      limit: 25,
      cursor: 1,
    });
    assert.equal(url.searchParams.get("netuid"), "7");
    assert.equal(url.searchParams.get("status"), "ok");
    assert.equal(url.searchParams.get("sort"), "latency_ms");
    assert.equal(url.searchParams.get("limit"), "25");
  });

  test("rejects invalid netuid and malformed enums", () => {
    for (const [args, pattern] of [
      [{ netuid: -1 }, /netuid must be a non-negative integer/],
      [{ status: "alive" }, /must be one of:/],
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
});

describe("health-history-mcp — loadHealthHistory", () => {
  test("rejects malformed dates before artifact I/O", async () => {
    await assert.rejects(
      () =>
        loadHealthHistory(
          makeCtx(),
          { date: "June" },
          makeDeps({ missing: true }),
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

  test("maps artifact misses to not_found", async () => {
    await assert.rejects(
      () =>
        loadHealthHistory(
          makeCtx(),
          { date: HISTORY_BLOB.date },
          makeDeps({ missing: true }),
        ),
      (err) => {
        assert.equal(err.healthHistoryMcp, true);
        assert.equal(err.code, "not_found");
        return true;
      },
    );
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
    assert.equal(MCP_SERVER_VERSION, "1.21.0");
    assert.match(MCP_INSTRUCTIONS, /get_health_history/);
    const tool = MCP_TOOLS.find((t) => t.name === "get_health_history");
    assert.ok(tool?.handler);
    assert.equal(tool.title, GET_HEALTH_HISTORY_MCP_TOOL.title);
  });
});
