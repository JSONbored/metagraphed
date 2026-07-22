import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import * as listQuery from "../workers/list-query.ts";
import {
  LIST_SUBNET_EVIDENCE_INSTRUCTIONS,
  LIST_SUBNET_EVIDENCE_MCP_TOOL,
  LIST_SUBNET_EVIDENCE_OUTPUT_SCHEMA,
  loadSubnetEvidenceList,
  subnetEvidenceArtifactPath,
  subnetEvidenceMcpError,
  subnetEvidenceQueryUrl,
} from "../src/subnet-evidence-mcp.ts";
import {
  MCP_INSTRUCTIONS,
  MCP_SERVER_VERSION,
  MCP_TOOLS,
} from "../src/mcp-server.mjs";

const NETUID = 7;
const ARTIFACT = subnetEvidenceArtifactPath(NETUID);

const SAMPLE_BLOB = {
  generated_at: "2026-07-01T00:00:00.000Z",
  netuid: NETUID,
  claims: [
    {
      subject: "SN7 openapi",
      claim: "SN7 publishes machine-readable OpenAPI",
      source_url: "https://example.com/openapi.json",
      support_summary: "verified live",
      verified_at: "2026-06-01T00:00:00.000Z",
    },
    {
      subject: "SN7 website",
      claim: "SN7 website documents integration",
      source_url: "https://example.com/docs",
      support_summary: "needs review",
      verified_at: "2026-05-01T00:00:00.000Z",
    },
  ],
};

function readArtifact(_env, path) {
  if (path === ARTIFACT) {
    return Promise.resolve({ ok: true, data: SAMPLE_BLOB });
  }
  return Promise.resolve({ ok: false, code: "artifact_not_found" });
}

describe("subnet-evidence-mcp", () => {
  test("subnetEvidenceArtifactPath builds the per-subnet artifact key", () => {
    assert.equal(subnetEvidenceArtifactPath(7), "/metagraph/evidence/7.json");
  });

  test("subnetEvidenceMcpError is shaped for MCP toolError handling", () => {
    const err = subnetEvidenceMcpError("invalid_params", "bad sort");
    assert.equal(err.code, "invalid_params");
    assert.equal(err.toolError, true);
  });

  test("subnetEvidenceQueryUrl validates filters and cursor", () => {
    const url = subnetEvidenceQueryUrl({
      netuid: NETUID,
      q: "openapi",
      sort: "verified_at",
      order: "desc",
      fields: "subject,claim",
      limit: 10,
      cursor: 5,
    });
    assert.equal(url.searchParams.get("q"), "openapi");
    assert.equal(url.searchParams.get("sort"), "verified_at");
    assert.equal(url.searchParams.get("limit"), "10");
    assert.equal(url.searchParams.get("cursor"), "5");
  });

  test("subnetEvidenceQueryUrl rejects missing netuid", () => {
    assert.throws(
      () => subnetEvidenceQueryUrl({}),
      (err) => err.code === "invalid_params",
    );
  });

  test("subnetEvidenceQueryUrl rejects empty q and invalid sort", () => {
    assert.throws(
      () => subnetEvidenceQueryUrl({ netuid: NETUID, q: "   " }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => subnetEvidenceQueryUrl({ netuid: NETUID, sort: "not_a_column" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("subnetEvidenceQueryUrl rejects non-string q and invalid order", () => {
    assert.throws(
      () => subnetEvidenceQueryUrl({ netuid: NETUID, q: 42 }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => subnetEvidenceQueryUrl({ netuid: NETUID, order: "sideways" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("subnetEvidenceQueryUrl rejects empty fields and non-string fields", () => {
    assert.throws(
      () => subnetEvidenceQueryUrl({ netuid: NETUID, fields: "   " }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => subnetEvidenceQueryUrl({ netuid: NETUID, fields: 42 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("subnetEvidenceQueryUrl trims and forwards a fields projection", () => {
    const url = subnetEvidenceQueryUrl({
      netuid: NETUID,
      fields: " subject,claim ",
    });
    assert.equal(url.searchParams.get("fields"), "subject,claim");
  });

  test("subnetEvidenceQueryUrl clamps a non-numeric limit to the default", () => {
    const url = subnetEvidenceQueryUrl({ netuid: NETUID, limit: "lots" });
    assert.equal(url.searchParams.get("limit"), "50");
  });

  test("subnetEvidenceQueryUrl clamps a sub-minimum numeric limit to the default", () => {
    const url = subnetEvidenceQueryUrl({ netuid: NETUID, limit: 0 });
    assert.equal(url.searchParams.get("limit"), "50");
  });

  test("subnetEvidenceQueryUrl rejects a fractional netuid", () => {
    assert.throws(
      () => subnetEvidenceQueryUrl({ netuid: 1.5 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("subnetEvidenceQueryUrl rejects a fractional cursor", () => {
    assert.throws(
      () => subnetEvidenceQueryUrl({ netuid: NETUID, cursor: 1.5 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("subnetEvidenceQueryUrl rejects negative cursor", () => {
    assert.throws(
      () => subnetEvidenceQueryUrl({ netuid: NETUID, cursor: -1 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("subnetEvidenceQueryUrl clamps limit above the MCP maximum", () => {
    const url = subnetEvidenceQueryUrl({ netuid: NETUID, limit: 500 });
    assert.equal(url.searchParams.get("limit"), "100");
  });

  test("loadSubnetEvidenceList returns filtered rows with pagination meta", async () => {
    const out = await loadSubnetEvidenceList(
      { env: {}, readArtifact },
      { netuid: NETUID, q: "openapi" },
    );
    assert.equal(out.returned, 1);
    assert.match(out.claims[0].claim, /OpenAPI/);
    assert.equal(out.netuid, NETUID);
  });

  test("loadSubnetEvidenceList sorts and pages the collection", async () => {
    const out = await loadSubnetEvidenceList(
      { env: {}, readArtifact },
      { netuid: NETUID, sort: "verified_at", order: "desc", limit: 1 },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.total, 2);
    assert.equal(out.next_cursor, 1);
  });

  test("loadSubnetEvidenceList uses an injected readArtifact dep", async () => {
    const out = await loadSubnetEvidenceList(
      { env: {}, readArtifact: async () => ({ ok: false }) },
      { netuid: 0 },
      {
        readArtifact: async () => ({
          ok: true,
          data: {
            claims: [{ subject: "SN0", claim: "test claim" }],
          },
        }),
      },
    );
    assert.equal(out.claims[0].subject, "SN0");
  });

  test("loadSubnetEvidenceList maps artifact_not_found to not_found", async () => {
    await assert.rejects(
      () =>
        loadSubnetEvidenceList(
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

  test("loadSubnetEvidenceList surfaces other artifact failures", async () => {
    await assert.rejects(
      () =>
        loadSubnetEvidenceList(
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
        /evidence\/7\.json/.test(err.message),
    );
  });

  test("loadSubnetEvidenceList rejects invalid list-query params from REST parity", async () => {
    await assert.rejects(
      () =>
        loadSubnetEvidenceList(
          { env: {}, readArtifact },
          { netuid: NETUID, fields: "not_a_column" },
        ),
      (err) => err.code === "invalid_params",
    );
  });

  test("loadSubnetEvidenceList projects row fields when requested", async () => {
    const out = await loadSubnetEvidenceList(
      { env: {}, readArtifact },
      { netuid: NETUID, fields: "subject,claim", limit: 1 },
    );
    assert.deepEqual(out.claims[0], {
      subject: "SN7 openapi",
      claim: "SN7 publishes machine-readable OpenAPI",
    });
  });

  test("loadSubnetEvidenceList omits nullable artifact metadata when absent", async () => {
    const out = await loadSubnetEvidenceList(
      {
        env: {},
        readArtifact: async () => ({
          ok: true,
          data: { claims: [{ subject: "SN0", claim: "test" }] },
        }),
      },
      { netuid: 0 },
    );
    assert.equal(out.generated_at, null);
  });

  test("loadSubnetEvidenceList treats a non-array claims key as empty", async () => {
    const out = await loadSubnetEvidenceList(
      {
        env: {},
        readArtifact: async () => ({
          ok: true,
          data: { claims: null },
        }),
      },
      { netuid: NETUID },
    );
    assert.deepEqual(out.claims, []);
    assert.equal(out.total, 0);
  });

  test("loadSubnetEvidenceList falls back when pagination meta is absent", async () => {
    const spy = vi.spyOn(listQuery, "applyQueryFilters").mockReturnValue({
      data: { claims: [{ subject: "a" }, { subject: "b" }] },
      meta: {},
    });
    try {
      const out = await loadSubnetEvidenceList(
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

  test("loadSubnetEvidenceList rejects a malformed artifact payload", async () => {
    await assert.rejects(
      () =>
        loadSubnetEvidenceList(
          {
            env: {},
            readArtifact: async () => ({ ok: true, data: null }),
          },
          { netuid: NETUID },
        ),
      (err) => err.code === "not_found",
    );
  });

  test("loadSubnetEvidenceList defaults code when the read result is bare", async () => {
    await assert.rejects(
      () =>
        loadSubnetEvidenceList(
          {
            env: {},
            readArtifact: async () => ({ ok: false }),
          },
          { netuid: NETUID },
        ),
      (err) => err.code === "artifact_unavailable",
    );
  });

  test("loadSubnetEvidenceList rejects missing netuid", async () => {
    await assert.rejects(
      () => loadSubnetEvidenceList({ env: {}, readArtifact }, {}),
      (err) => err.code === "invalid_params",
    );
  });

  test("MCP tool metadata and outputSchema compile", () => {
    assert.equal(LIST_SUBNET_EVIDENCE_MCP_TOOL.name, "list_subnet_evidence");
    assert.match(LIST_SUBNET_EVIDENCE_INSTRUCTIONS, /list_subnet_evidence/);
    assert.ok(
      new Ajv2020({ strict: false }).compile(
        LIST_SUBNET_EVIDENCE_OUTPUT_SCHEMA,
      ),
    );
  });

  test("MCP server exports wire list_subnet_evidence at the bumped SemVer", () => {
    assert.match(MCP_SERVER_VERSION, /^\d+\.\d+\.\d+$/);
    assert.match(MCP_INSTRUCTIONS, /list_subnet_evidence/);
    const tool = MCP_TOOLS.find((t) => t.name === "list_subnet_evidence");
    assert.ok(tool);
    assert.equal(tool.title, "List one subnet's evidence claims");
  });
});
