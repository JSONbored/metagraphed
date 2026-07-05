import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import * as listQuery from "../workers/list-query.mjs";
import {
  LIST_SUBNET_CANDIDATES_INSTRUCTIONS,
  LIST_SUBNET_CANDIDATES_MCP_TOOL,
  LIST_SUBNET_CANDIDATES_OUTPUT_SCHEMA,
  loadSubnetCandidatesList,
  subnetCandidatesArtifactPath,
  subnetCandidatesMcpError,
  subnetCandidatesQueryUrl,
} from "../src/subnet-candidates-mcp.mjs";
import {
  MCP_INSTRUCTIONS,
  MCP_SERVER_VERSION,
  MCP_TOOLS,
} from "../src/mcp-server.mjs";

const NETUID = 7;
const ARTIFACT = subnetCandidatesArtifactPath(NETUID);

const SAMPLE_BLOB = {
  generated_at: "2026-07-01T00:00:00.000Z",
  netuid: NETUID,
  candidates: [
    {
      id: "allways-openapi",
      netuid: NETUID,
      kind: "openapi",
      provider: "allways",
      state: "schema-valid",
      confidence: 0.92,
    },
    {
      id: "allways-docs",
      netuid: NETUID,
      kind: "docs",
      provider: "allways",
      state: "maintainer-review",
      confidence: 0.71,
    },
  ],
};

function readArtifact(_env, path) {
  if (path === ARTIFACT) {
    return Promise.resolve({ ok: true, data: SAMPLE_BLOB });
  }
  return Promise.resolve({ ok: false, code: "artifact_not_found" });
}

describe("subnet-candidates-mcp", () => {
  test("subnetCandidatesArtifactPath builds the per-subnet artifact key", () => {
    assert.equal(
      subnetCandidatesArtifactPath(7),
      "/metagraph/candidates/7.json",
    );
  });

  test("subnetCandidatesMcpError is shaped for MCP toolError handling", () => {
    const err = subnetCandidatesMcpError("invalid_params", "bad state");
    assert.equal(err.code, "invalid_params");
    assert.equal(err.toolError, true);
  });

  test("subnetCandidatesQueryUrl validates filters and cursor", () => {
    const url = subnetCandidatesQueryUrl({
      netuid: NETUID,
      kind: "openapi",
      provider: "allways",
      state: "schema-valid",
      sort: "confidence",
      order: "desc",
      fields: "id,kind",
      limit: 10,
      cursor: 5,
    });
    assert.equal(url.searchParams.get("kind"), "openapi");
    assert.equal(url.searchParams.get("provider"), "allways");
    assert.equal(url.searchParams.get("state"), "schema-valid");
    assert.equal(url.searchParams.get("sort"), "confidence");
    assert.equal(url.searchParams.get("limit"), "10");
    assert.equal(url.searchParams.get("cursor"), "5");
  });

  test("subnetCandidatesQueryUrl rejects missing netuid", () => {
    assert.throws(
      () => subnetCandidatesQueryUrl({}),
      (err) => err.code === "invalid_params",
    );
  });

  test("subnetCandidatesQueryUrl rejects invalid kind", () => {
    assert.throws(
      () => subnetCandidatesQueryUrl({ netuid: NETUID, kind: "bogus" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("subnetCandidatesQueryUrl rejects invalid state", () => {
    assert.throws(
      () => subnetCandidatesQueryUrl({ netuid: NETUID, state: "approved" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("subnetCandidatesQueryUrl rejects empty provider and invalid sort", () => {
    assert.throws(
      () => subnetCandidatesQueryUrl({ netuid: NETUID, provider: "   " }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => subnetCandidatesQueryUrl({ netuid: NETUID, sort: "not_a_column" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("subnetCandidatesQueryUrl rejects non-string provider and invalid order", () => {
    assert.throws(
      () => subnetCandidatesQueryUrl({ netuid: NETUID, provider: 42 }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => subnetCandidatesQueryUrl({ netuid: NETUID, order: "sideways" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("subnetCandidatesQueryUrl rejects empty fields and non-string fields", () => {
    assert.throws(
      () => subnetCandidatesQueryUrl({ netuid: NETUID, fields: "   " }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => subnetCandidatesQueryUrl({ netuid: NETUID, fields: 42 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("subnetCandidatesQueryUrl trims and forwards a fields projection", () => {
    const url = subnetCandidatesQueryUrl({
      netuid: NETUID,
      fields: " id,kind ",
    });
    assert.equal(url.searchParams.get("fields"), "id,kind");
  });

  test("subnetCandidatesQueryUrl clamps a non-numeric limit to the default", () => {
    const url = subnetCandidatesQueryUrl({ netuid: NETUID, limit: "lots" });
    assert.equal(url.searchParams.get("limit"), "50");
  });

  test("subnetCandidatesQueryUrl clamps a sub-minimum numeric limit to the default", () => {
    const url = subnetCandidatesQueryUrl({ netuid: NETUID, limit: 0 });
    assert.equal(url.searchParams.get("limit"), "50");
  });

  test("subnetCandidatesQueryUrl rejects a fractional netuid", () => {
    assert.throws(
      () => subnetCandidatesQueryUrl({ netuid: 1.5 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("subnetCandidatesQueryUrl rejects a fractional cursor", () => {
    assert.throws(
      () => subnetCandidatesQueryUrl({ netuid: NETUID, cursor: 1.5 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("subnetCandidatesQueryUrl rejects negative cursor", () => {
    assert.throws(
      () => subnetCandidatesQueryUrl({ netuid: NETUID, cursor: -1 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("subnetCandidatesQueryUrl clamps limit above the MCP maximum", () => {
    const url = subnetCandidatesQueryUrl({ netuid: NETUID, limit: 500 });
    assert.equal(url.searchParams.get("limit"), "100");
  });

  test("loadSubnetCandidatesList returns filtered rows with pagination meta", async () => {
    const out = await loadSubnetCandidatesList(
      { env: {}, readArtifact },
      { netuid: NETUID, state: "schema-valid" },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.candidates[0].kind, "openapi");
    assert.equal(out.netuid, NETUID);
  });

  test("loadSubnetCandidatesList sorts and pages the collection", async () => {
    const out = await loadSubnetCandidatesList(
      { env: {}, readArtifact },
      { netuid: NETUID, sort: "confidence", order: "desc", limit: 1 },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.total, 2);
    assert.equal(out.next_cursor, 1);
  });

  test("loadSubnetCandidatesList uses an injected readArtifact dep", async () => {
    const out = await loadSubnetCandidatesList(
      { env: {}, readArtifact: async () => ({ ok: false }) },
      { netuid: 0 },
      {
        readArtifact: async () => ({
          ok: true,
          data: {
            candidates: [{ netuid: 0, kind: "docs", state: "schema-valid" }],
          },
        }),
      },
    );
    assert.equal(out.candidates[0].netuid, 0);
  });

  test("loadSubnetCandidatesList maps artifact_not_found to not_found", async () => {
    await assert.rejects(
      () =>
        loadSubnetCandidatesList(
          {
            env: {},
            readArtifact: async () => ({
              ok: false,
              code: "artifact_not_found",
            }),
          },
          { netuid: NETUID },
        ),
      (err) => err.code === "not_found",
    );
  });

  test("loadSubnetCandidatesList surfaces other artifact failures", async () => {
    await assert.rejects(
      () =>
        loadSubnetCandidatesList(
          {
            env: {},
            readArtifact: async () => ({
              ok: false,
              code: "artifact_timeout",
            }),
          },
          { netuid: NETUID },
        ),
      (err) =>
        err.code === "artifact_timeout" &&
        /candidates\/7\.json/.test(err.message),
    );
  });

  test("loadSubnetCandidatesList rejects invalid list-query params from REST parity", async () => {
    await assert.rejects(
      () =>
        loadSubnetCandidatesList(
          { env: {}, readArtifact },
          { netuid: NETUID, fields: "not_a_column" },
        ),
      (err) => err.code === "invalid_params",
    );
  });

  test("loadSubnetCandidatesList projects row fields when requested", async () => {
    const out = await loadSubnetCandidatesList(
      { env: {}, readArtifact },
      { netuid: NETUID, fields: "id,kind", limit: 1 },
    );
    assert.deepEqual(out.candidates[0], {
      id: "allways-openapi",
      kind: "openapi",
    });
  });

  test("loadSubnetCandidatesList omits nullable artifact metadata when absent", async () => {
    const out = await loadSubnetCandidatesList(
      {
        env: {},
        readArtifact: async () => ({
          ok: true,
          data: {
            candidates: [{ netuid: 0, kind: "docs", state: "schema-valid" }],
          },
        }),
      },
      { netuid: 0 },
    );
    assert.equal(out.generated_at, null);
  });

  test("loadSubnetCandidatesList treats a non-array candidates key as empty", async () => {
    const out = await loadSubnetCandidatesList(
      {
        env: {},
        readArtifact: async () => ({
          ok: true,
          data: { candidates: null },
        }),
      },
      { netuid: NETUID },
    );
    assert.deepEqual(out.candidates, []);
    assert.equal(out.total, 0);
  });

  test("loadSubnetCandidatesList falls back when pagination meta is absent", async () => {
    const spy = vi.spyOn(listQuery, "applyQueryFilters").mockReturnValue({
      data: { candidates: [{ netuid: 9 }, { netuid: 9 }] },
      meta: {},
    });
    try {
      const out = await loadSubnetCandidatesList(
        { env: {}, readArtifact },
        { netuid: NETUID },
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

  test("loadSubnetCandidatesList rejects a malformed artifact payload", async () => {
    await assert.rejects(
      () =>
        loadSubnetCandidatesList(
          {
            env: {},
            readArtifact: async () => ({ ok: true, data: null }),
          },
          { netuid: NETUID },
        ),
      (err) => err.code === "not_found",
    );
  });

  test("loadSubnetCandidatesList defaults code when the read result is bare", async () => {
    await assert.rejects(
      () =>
        loadSubnetCandidatesList(
          {
            env: {},
            readArtifact: async () => ({ ok: false }),
          },
          { netuid: NETUID },
        ),
      (err) => err.code === "artifact_unavailable",
    );
  });

  test("loadSubnetCandidatesList rejects missing netuid", async () => {
    await assert.rejects(
      () => loadSubnetCandidatesList({ env: {}, readArtifact }, {}),
      (err) => err.code === "invalid_params",
    );
  });

  test("MCP tool metadata and outputSchema compile", () => {
    assert.equal(
      LIST_SUBNET_CANDIDATES_MCP_TOOL.name,
      "list_subnet_candidates",
    );
    assert.match(LIST_SUBNET_CANDIDATES_INSTRUCTIONS, /list_subnet_candidates/);
    assert.ok(
      new Ajv2020({ strict: false }).compile(
        LIST_SUBNET_CANDIDATES_OUTPUT_SCHEMA,
      ),
    );
  });

  test("MCP server exports wire list_subnet_candidates at the bumped SemVer", () => {
    assert.equal(MCP_SERVER_VERSION, "1.75.0");
    assert.match(MCP_INSTRUCTIONS, /list_subnet_candidates/);
    const tool = MCP_TOOLS.find((t) => t.name === "list_subnet_candidates");
    assert.ok(tool);
    assert.equal(tool.title, "List one subnet's candidate surfaces");
  });
});
