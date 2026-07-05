import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import * as listQuery from "../workers/list-query.mjs";
import {
  ENDPOINT_INCIDENTS_ARTIFACT,
  LIST_ENDPOINT_INCIDENTS_INSTRUCTIONS,
  LIST_ENDPOINT_INCIDENTS_MCP_TOOL,
  LIST_ENDPOINT_INCIDENTS_OUTPUT_SCHEMA,
  endpointIncidentsMcpError,
  endpointIncidentsQueryUrl,
  loadEndpointIncidentsList,
} from "../src/endpoint-incidents-mcp.mjs";
import {
  MCP_INSTRUCTIONS,
  MCP_SERVER_VERSION,
  MCP_TOOLS,
} from "../src/mcp-server.mjs";

const SAMPLE_BLOB = {
  generated_at: "2026-07-01T00:00:00.000Z",
  notes: ["probe-derived only"],
  summary: { incident_count: 2, active_count: 2 },
  incidents: [
    {
      id: "incident-a",
      endpoint_id: "a",
      netuid: 7,
      kind: "subnet-api",
      provider: "allways",
      status: "failed",
      severity: "critical",
      state: "active",
    },
    {
      id: "incident-b",
      endpoint_id: "b",
      netuid: 31,
      kind: "openapi",
      provider: "candles",
      status: "degraded",
      severity: "warning",
      state: "active",
    },
  ],
};

function readArtifact(_env, path) {
  if (path === ENDPOINT_INCIDENTS_ARTIFACT) {
    return Promise.resolve({ ok: true, data: SAMPLE_BLOB });
  }
  return Promise.resolve({ ok: false, code: "artifact_not_found" });
}

describe("endpoint-incidents-mcp", () => {
  test("endpointIncidentsMcpError is shaped for MCP toolError handling", () => {
    const err = endpointIncidentsMcpError("invalid_params", "bad sort");
    assert.equal(err.code, "invalid_params");
    assert.equal(err.toolError, true);
  });

  test("endpointIncidentsQueryUrl validates filters and cursor", () => {
    const url = endpointIncidentsQueryUrl({
      netuid: 7,
      kind: "subnet-api",
      provider: "allways",
      status: "failed",
      severity: "critical",
      state: "active",
      sort: "severity",
      order: "desc",
      limit: 10,
      cursor: 5,
    });
    assert.equal(url.searchParams.get("netuid"), "7");
    assert.equal(url.searchParams.get("kind"), "subnet-api");
    assert.equal(url.searchParams.get("provider"), "allways");
    assert.equal(url.searchParams.get("status"), "failed");
    assert.equal(url.searchParams.get("severity"), "critical");
    assert.equal(url.searchParams.get("state"), "active");
    assert.equal(url.searchParams.get("sort"), "severity");
    assert.equal(url.searchParams.get("limit"), "10");
    assert.equal(url.searchParams.get("cursor"), "5");
  });

  test("endpointIncidentsQueryUrl rejects invalid severity", () => {
    assert.throws(
      () => endpointIncidentsQueryUrl({ severity: "bogus" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("endpointIncidentsQueryUrl rejects invalid state", () => {
    assert.throws(
      () => endpointIncidentsQueryUrl({ state: "bogus" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("endpointIncidentsQueryUrl rejects invalid kind", () => {
    assert.throws(
      () => endpointIncidentsQueryUrl({ kind: "bogus" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("endpointIncidentsQueryUrl rejects invalid status", () => {
    assert.throws(
      () => endpointIncidentsQueryUrl({ status: "bogus" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("endpointIncidentsQueryUrl rejects invalid netuid", () => {
    assert.throws(
      () => endpointIncidentsQueryUrl({ netuid: -1 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("endpointIncidentsQueryUrl rejects a fractional netuid", () => {
    assert.throws(
      () => endpointIncidentsQueryUrl({ netuid: 1.5 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("endpointIncidentsQueryUrl rejects empty provider", () => {
    assert.throws(
      () => endpointIncidentsQueryUrl({ provider: "   " }),
      (err) => err.code === "invalid_params",
    );
  });

  test("endpointIncidentsQueryUrl rejects non-string provider", () => {
    assert.throws(
      () => endpointIncidentsQueryUrl({ provider: 42 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("endpointIncidentsQueryUrl rejects negative cursor", () => {
    assert.throws(
      () => endpointIncidentsQueryUrl({ cursor: -1 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("endpointIncidentsQueryUrl rejects empty fields projection", () => {
    assert.throws(
      () => endpointIncidentsQueryUrl({ fields: "   " }),
      (err) => err.code === "invalid_params",
    );
  });

  test("endpointIncidentsQueryUrl rejects non-string fields", () => {
    assert.throws(
      () => endpointIncidentsQueryUrl({ fields: 42 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("endpointIncidentsQueryUrl trims and forwards a fields projection", () => {
    const url = endpointIncidentsQueryUrl({ fields: " netuid,severity " });
    assert.equal(url.searchParams.get("fields"), "netuid,severity");
  });

  test("endpointIncidentsQueryUrl clamps a non-numeric limit to the default", () => {
    const url = endpointIncidentsQueryUrl({ limit: "lots" });
    assert.equal(url.searchParams.get("limit"), "50");
  });

  test("endpointIncidentsQueryUrl clamps a sub-minimum numeric limit to the default", () => {
    const url = endpointIncidentsQueryUrl({ limit: 0 });
    assert.equal(url.searchParams.get("limit"), "50");
  });

  test("endpointIncidentsQueryUrl clamps limit above the MCP maximum", () => {
    const url = endpointIncidentsQueryUrl({ limit: 500 });
    assert.equal(url.searchParams.get("limit"), "100");
  });

  test("loadEndpointIncidentsList returns filtered rows with pagination meta", async () => {
    const out = await loadEndpointIncidentsList(
      { env: {}, readArtifact },
      { netuid: 7 },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.incidents[0].netuid, 7);
    assert.equal(out.incidents[0].severity, "critical");
  });

  test("loadEndpointIncidentsList sorts and pages the collection", async () => {
    const out = await loadEndpointIncidentsList(
      { env: {}, readArtifact },
      { sort: "netuid", order: "desc", limit: 1 },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.total, 2);
    assert.equal(out.incidents[0].netuid, 31);
    assert.equal(out.next_cursor, 1);
  });

  test("loadEndpointIncidentsList uses an injected readArtifact dep", async () => {
    const out = await loadEndpointIncidentsList(
      { env: {}, readArtifact: async () => ({ ok: false }) },
      {},
      {
        readArtifact: async () => ({
          ok: true,
          data: { incidents: [{ id: "solo" }] },
        }),
      },
    );
    assert.equal(out.incidents[0].id, "solo");
  });

  test("loadEndpointIncidentsList maps artifact_not_found to not_found", async () => {
    await assert.rejects(
      () =>
        loadEndpointIncidentsList(
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

  test("loadEndpointIncidentsList surfaces other artifact failures", async () => {
    await assert.rejects(
      () =>
        loadEndpointIncidentsList(
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
        /endpoint-incidents\.json/.test(err.message),
    );
  });

  test("loadEndpointIncidentsList rejects invalid list-query params from REST parity", async () => {
    await assert.rejects(
      () =>
        loadEndpointIncidentsList(
          { env: {}, readArtifact },
          { fields: "not_a_column" },
        ),
      (err) => err.code === "invalid_params",
    );
  });

  test("loadEndpointIncidentsList projects row fields when requested", async () => {
    const out = await loadEndpointIncidentsList(
      { env: {}, readArtifact },
      { fields: "netuid,severity", limit: 1 },
    );
    assert.deepEqual(out.incidents[0], { netuid: 7, severity: "critical" });
  });

  test("loadEndpointIncidentsList preserves array notes and summary from the artifact", async () => {
    const out = await loadEndpointIncidentsList(
      { env: {}, readArtifact },
      { limit: 1 },
    );
    assert.deepEqual(out.notes, ["probe-derived only"]);
    assert.equal(out.summary.incident_count, 2);
  });

  test("loadEndpointIncidentsList omits nullable artifact metadata when absent", async () => {
    const out = await loadEndpointIncidentsList(
      {
        env: {},
        readArtifact: async () => ({
          ok: true,
          data: { incidents: [{ id: "solo" }] },
        }),
      },
      {},
    );
    assert.equal(out.generated_at, null);
    assert.equal(out.notes, null);
    assert.equal(out.summary, null);
  });

  test("loadEndpointIncidentsList treats a non-array incidents key as empty", async () => {
    const out = await loadEndpointIncidentsList(
      {
        env: {},
        readArtifact: async () => ({
          ok: true,
          data: { incidents: null },
        }),
      },
      {},
    );
    assert.deepEqual(out.incidents, []);
    assert.equal(out.total, 0);
  });

  test("loadEndpointIncidentsList falls back when pagination meta is absent", async () => {
    const spy = vi.spyOn(listQuery, "applyQueryFilters").mockReturnValue({
      data: { incidents: [{ id: "a" }, { id: "b" }] },
      meta: {},
    });
    try {
      const out = await loadEndpointIncidentsList(
        { env: {}, readArtifact },
        {},
      );
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

  test("loadEndpointIncidentsList rejects a malformed artifact payload", async () => {
    await assert.rejects(
      () =>
        loadEndpointIncidentsList(
          {
            env: {},
            readArtifact: async () => ({ ok: true, data: null }),
          },
          {},
        ),
      (err) => err.code === "not_found",
    );
  });

  test("loadEndpointIncidentsList defaults code when the read result is bare", async () => {
    await assert.rejects(
      () =>
        loadEndpointIncidentsList(
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
    assert.equal(
      LIST_ENDPOINT_INCIDENTS_MCP_TOOL.name,
      "list_endpoint_incidents",
    );
    assert.match(
      LIST_ENDPOINT_INCIDENTS_INSTRUCTIONS,
      /list_endpoint_incidents/,
    );
    assert.ok(
      new Ajv2020({ strict: false }).compile(
        LIST_ENDPOINT_INCIDENTS_OUTPUT_SCHEMA,
      ),
    );
  });

  test("MCP server exports wire list_endpoint_incidents at the bumped SemVer", () => {
    assert.equal(MCP_SERVER_VERSION, "1.63.0");
    assert.match(MCP_INSTRUCTIONS, /list_endpoint_incidents/);
    const tool = MCP_TOOLS.find((t) => t.name === "list_endpoint_incidents");
    assert.ok(tool);
    assert.equal(tool.title, "List endpoint incidents");
  });
});
