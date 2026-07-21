import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import * as listQuery from "../workers/list-query.ts";
import {
  EVIDENCE_LEDGER_ARTIFACT,
  LIST_EVIDENCE_INSTRUCTIONS,
  LIST_EVIDENCE_MCP_TOOL,
  LIST_EVIDENCE_OUTPUT_SCHEMA,
  evidenceMcpError,
  evidenceQueryUrl,
  loadEvidenceList,
} from "../src/evidence-mcp.mjs";
import { MCP_INSTRUCTIONS, MCP_TOOLS } from "../src/mcp-server.mjs";

const SAMPLE_BLOB = {
  generated_at: "2026-07-01T00:00:00.000Z",
  schema_version: 1,
  summary: { claim_count: 2 },
  claims: [
    {
      subject: "SN7 openapi",
      claim: "SN7 publishes machine-readable OpenAPI",
      source_url: "https://example.com/openapi.json",
      support_summary: "verified live",
      verified_at: "2026-06-01T00:00:00.000Z",
    },
    {
      subject: "SN8 website",
      claim: "SN8 website documents integration",
      source_url: "https://example.com/docs",
      support_summary: "needs review",
      verified_at: "2026-05-01T00:00:00.000Z",
    },
  ],
};

function readArtifact(_env, path) {
  if (path === EVIDENCE_LEDGER_ARTIFACT) {
    return Promise.resolve({ ok: true, data: SAMPLE_BLOB });
  }
  return Promise.resolve({ ok: false, code: "artifact_not_found" });
}

describe("evidence-mcp", () => {
  test("evidenceMcpError is shaped for MCP toolError handling", () => {
    const err = evidenceMcpError("invalid_params", "bad sort");
    assert.equal(err.code, "invalid_params");
    assert.equal(err.toolError, true);
  });

  test("evidenceQueryUrl validates filters and cursor", () => {
    const url = evidenceQueryUrl({
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

  test("evidenceQueryUrl rejects empty q and invalid sort", () => {
    assert.throws(
      () => evidenceQueryUrl({ q: "   " }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => evidenceQueryUrl({ sort: "not_a_column" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("evidenceQueryUrl rejects non-string q and invalid order", () => {
    assert.throws(
      () => evidenceQueryUrl({ q: 42 }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => evidenceQueryUrl({ order: "sideways" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("evidenceQueryUrl rejects empty fields and non-string fields", () => {
    assert.throws(
      () => evidenceQueryUrl({ fields: "   " }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => evidenceQueryUrl({ fields: 42 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("evidenceQueryUrl trims and forwards a fields projection", () => {
    const url = evidenceQueryUrl({ fields: " subject,claim " });
    assert.equal(url.searchParams.get("fields"), "subject,claim");
  });

  test("evidenceQueryUrl rejects a non-numeric limit", () => {
    assert.throws(
      () => evidenceQueryUrl({ limit: "lots" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("evidenceQueryUrl rejects a sub-minimum limit", () => {
    assert.throws(
      () => evidenceQueryUrl({ limit: 0 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("evidenceQueryUrl rejects a fractional cursor", () => {
    assert.throws(
      () => evidenceQueryUrl({ cursor: 1.5 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("evidenceQueryUrl rejects negative cursor", () => {
    assert.throws(
      () => evidenceQueryUrl({ cursor: -1 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("evidenceQueryUrl rejects a limit above the MCP maximum", () => {
    assert.throws(
      () => evidenceQueryUrl({ limit: 500 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("loadEvidenceList returns filtered rows with pagination meta", async () => {
    const out = await loadEvidenceList(
      { env: {}, readArtifact },
      { q: "openapi" },
    );
    assert.equal(out.returned, 1);
    assert.match(out.claims[0].claim, /OpenAPI/);
  });

  test("loadEvidenceList sorts and pages the collection", async () => {
    const out = await loadEvidenceList(
      { env: {}, readArtifact },
      { sort: "verified_at", order: "desc", limit: 1 },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.total, 2);
    assert.equal(out.next_cursor, 1);
  });

  test("loadEvidenceList uses an injected readArtifact dep", async () => {
    const out = await loadEvidenceList(
      { env: {}, readArtifact: async () => ({ ok: false }) },
      {},
      {
        readArtifact: async () => ({
          ok: true,
          data: { claims: [{ subject: "SN0", claim: "test claim" }] },
        }),
      },
    );
    assert.equal(out.claims[0].subject, "SN0");
  });

  test("loadEvidenceList maps artifact_not_found to not_found", async () => {
    await assert.rejects(
      () =>
        loadEvidenceList(
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

  test("loadEvidenceList surfaces other artifact failures", async () => {
    await assert.rejects(
      () =>
        loadEvidenceList(
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
        /evidence-ledger\.json/.test(err.message),
    );
  });

  test("loadEvidenceList rejects invalid list-query params from REST parity", async () => {
    await assert.rejects(
      () =>
        loadEvidenceList({ env: {}, readArtifact }, { fields: "not_a_column" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("loadEvidenceList projects row fields when requested", async () => {
    const out = await loadEvidenceList(
      { env: {}, readArtifact },
      { fields: "subject,claim", limit: 1 },
    );
    assert.deepEqual(out.claims[0], {
      subject: "SN7 openapi",
      claim: "SN7 publishes machine-readable OpenAPI",
    });
  });

  test("loadEvidenceList preserves summary from the artifact", async () => {
    const out = await loadEvidenceList({ env: {}, readArtifact }, {});
    assert.deepEqual(out.summary, { claim_count: 2 });
  });

  test("loadEvidenceList omits nullable artifact metadata when absent", async () => {
    const out = await loadEvidenceList(
      {
        env: {},
        readArtifact: async () => ({
          ok: true,
          data: { claims: [{ subject: "SN0", claim: "test" }] },
        }),
      },
      {},
    );
    assert.equal(out.generated_at, null);
    assert.equal(out.schema_version, null);
    assert.equal(out.summary, null);
  });

  test("loadEvidenceList treats a non-array claims key as empty", async () => {
    const out = await loadEvidenceList(
      {
        env: {},
        readArtifact: async () => ({
          ok: true,
          data: { claims: null },
        }),
      },
      {},
    );
    assert.deepEqual(out.claims, []);
    assert.equal(out.total, 0);
  });

  test("loadEvidenceList falls back when pagination meta is absent", async () => {
    const spy = vi.spyOn(listQuery, "applyQueryFilters").mockReturnValue({
      data: { claims: [{ subject: "a" }, { subject: "b" }] },
      meta: {},
    });
    try {
      const out = await loadEvidenceList({ env: {}, readArtifact }, {});
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

  test("loadEvidenceList rejects a malformed artifact payload", async () => {
    await assert.rejects(
      () =>
        loadEvidenceList(
          {
            env: {},
            readArtifact: async () => ({ ok: true, data: null }),
          },
          {},
        ),
      (err) => err.code === "not_found",
    );
  });

  test("loadEvidenceList defaults code when the read result is bare", async () => {
    await assert.rejects(
      () =>
        loadEvidenceList(
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
    assert.equal(LIST_EVIDENCE_MCP_TOOL.name, "list_evidence");
    assert.match(LIST_EVIDENCE_INSTRUCTIONS, /list_evidence/);
    assert.ok(
      new Ajv2020({ strict: false }).compile(LIST_EVIDENCE_OUTPUT_SCHEMA),
    );
  });

  test("MCP server exports wire list_evidence", () => {
    assert.match(MCP_INSTRUCTIONS, /list_evidence/);
    const tool = MCP_TOOLS.find((t) => t.name === "list_evidence");
    assert.ok(tool);
    assert.equal(tool.title, "List the public evidence ledger");
  });
});
