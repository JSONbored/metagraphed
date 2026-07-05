import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import * as listQuery from "../workers/list-query.mjs";
import {
  ENRICHMENT_EVIDENCE_ARTIFACT,
  LIST_ENRICHMENT_EVIDENCE_INSTRUCTIONS,
  LIST_ENRICHMENT_EVIDENCE_MCP_TOOL,
  LIST_ENRICHMENT_EVIDENCE_OUTPUT_SCHEMA,
  enrichmentEvidenceMcpError,
  enrichmentEvidenceQueryUrl,
  loadEnrichmentEvidenceList,
} from "../src/enrichment-evidence-mcp.mjs";
import { MCP_INSTRUCTIONS, MCP_TOOLS } from "../src/mcp-server.mjs";

const SAMPLE_BLOB = {
  generated_at: "2026-07-01T00:00:00.000Z",
  notes: ["evidence drill-down"],
  entries: [
    {
      netuid: 7,
      name: "Allways",
      lane: "direct-submission",
      evidence_action: "replace-stale-evidence",
      priority_score: 88,
      missing_kinds: ["openapi"],
      direct_submission_kinds: ["openapi"],
    },
    {
      netuid: 12,
      name: "Compute",
      lane: "maintainer-review",
      evidence_action: "submit-new-evidence",
      priority_score: 72,
      missing_kinds: ["website"],
    },
  ],
};

function readArtifact(_env, path) {
  if (path === ENRICHMENT_EVIDENCE_ARTIFACT) {
    return Promise.resolve({ ok: true, data: SAMPLE_BLOB });
  }
  return Promise.resolve({ ok: false, code: "artifact_not_found" });
}

describe("enrichment-evidence-mcp", () => {
  test("enrichmentEvidenceMcpError is shaped for MCP toolError handling", () => {
    const err = enrichmentEvidenceMcpError("invalid_params", "bad lane");
    assert.equal(err.code, "invalid_params");
    assert.equal(err.toolError, true);
  });

  test("enrichmentEvidenceQueryUrl validates filters and cursor", () => {
    const url = enrichmentEvidenceQueryUrl({
      q: "openapi",
      netuid: 7,
      lane: "direct-submission",
      evidence_action: "replace-stale-evidence",
      direct_submission_kinds: "openapi",
      missing_kinds: "openapi",
      sort: "priority_score",
      order: "desc",
      fields: "netuid,lane",
      limit: 10,
      cursor: 5,
    });
    assert.equal(url.searchParams.get("q"), "openapi");
    assert.equal(url.searchParams.get("netuid"), "7");
    assert.equal(url.searchParams.get("lane"), "direct-submission");
    assert.equal(
      url.searchParams.get("evidence_action"),
      "replace-stale-evidence",
    );
    assert.equal(url.searchParams.get("sort"), "priority_score");
    assert.equal(url.searchParams.get("limit"), "10");
    assert.equal(url.searchParams.get("cursor"), "5");
  });

  test("enrichmentEvidenceQueryUrl rejects invalid lane", () => {
    assert.throws(
      () => enrichmentEvidenceQueryUrl({ lane: "bogus" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("enrichmentEvidenceQueryUrl rejects invalid evidence_action", () => {
    assert.throws(
      () => enrichmentEvidenceQueryUrl({ evidence_action: "bogus" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("enrichmentEvidenceQueryUrl rejects invalid netuid", () => {
    assert.throws(
      () => enrichmentEvidenceQueryUrl({ netuid: -1 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("enrichmentEvidenceQueryUrl rejects empty q and invalid sort", () => {
    assert.throws(
      () => enrichmentEvidenceQueryUrl({ q: "   " }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => enrichmentEvidenceQueryUrl({ sort: "not_a_column" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("enrichmentEvidenceQueryUrl rejects non-string q and invalid order", () => {
    assert.throws(
      () => enrichmentEvidenceQueryUrl({ q: 42 }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => enrichmentEvidenceQueryUrl({ order: "sideways" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("enrichmentEvidenceQueryUrl rejects empty fields and non-string fields", () => {
    assert.throws(
      () => enrichmentEvidenceQueryUrl({ fields: "   " }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => enrichmentEvidenceQueryUrl({ fields: 42 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("enrichmentEvidenceQueryUrl trims and forwards a fields projection", () => {
    const url = enrichmentEvidenceQueryUrl({ fields: " netuid,lane " });
    assert.equal(url.searchParams.get("fields"), "netuid,lane");
  });

  test("enrichmentEvidenceQueryUrl clamps a non-numeric limit to the default", () => {
    const url = enrichmentEvidenceQueryUrl({ limit: "lots" });
    assert.equal(url.searchParams.get("limit"), "50");
  });

  test("enrichmentEvidenceQueryUrl clamps a sub-minimum numeric limit to the default", () => {
    const url = enrichmentEvidenceQueryUrl({ limit: 0 });
    assert.equal(url.searchParams.get("limit"), "50");
  });

  test("enrichmentEvidenceQueryUrl rejects a fractional netuid", () => {
    assert.throws(
      () => enrichmentEvidenceQueryUrl({ netuid: 1.5 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("enrichmentEvidenceQueryUrl rejects a fractional cursor", () => {
    assert.throws(
      () => enrichmentEvidenceQueryUrl({ cursor: 1.5 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("enrichmentEvidenceQueryUrl rejects negative cursor", () => {
    assert.throws(
      () => enrichmentEvidenceQueryUrl({ cursor: -1 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("enrichmentEvidenceQueryUrl clamps limit above the MCP maximum", () => {
    const url = enrichmentEvidenceQueryUrl({ limit: 500 });
    assert.equal(url.searchParams.get("limit"), "100");
  });

  test("loadEnrichmentEvidenceList returns filtered rows with pagination meta", async () => {
    const out = await loadEnrichmentEvidenceList(
      { env: {}, readArtifact },
      { missing_kinds: "openapi" },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.entries[0].netuid, 7);
    assert.equal(out.entries[0].evidence_action, "replace-stale-evidence");
  });

  test("loadEnrichmentEvidenceList sorts and pages the collection", async () => {
    const out = await loadEnrichmentEvidenceList(
      { env: {}, readArtifact },
      { sort: "priority_score", order: "desc", limit: 1 },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.total, 2);
    assert.equal(out.entries[0].netuid, 7);
    assert.equal(out.next_cursor, 1);
  });

  test("loadEnrichmentEvidenceList uses an injected readArtifact dep", async () => {
    const out = await loadEnrichmentEvidenceList(
      { env: {}, readArtifact: async () => ({ ok: false }) },
      {},
      {
        readArtifact: async () => ({
          ok: true,
          data: {
            entries: [{ netuid: 0, lane: "monitoring-followup" }],
          },
        }),
      },
    );
    assert.equal(out.entries[0].netuid, 0);
  });

  test("loadEnrichmentEvidenceList maps artifact_not_found to not_found", async () => {
    await assert.rejects(
      () =>
        loadEnrichmentEvidenceList(
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

  test("loadEnrichmentEvidenceList surfaces other artifact failures", async () => {
    await assert.rejects(
      () =>
        loadEnrichmentEvidenceList(
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
        /enrichment-evidence\.json/.test(err.message),
    );
  });

  test("loadEnrichmentEvidenceList rejects invalid list-query params from REST parity", async () => {
    await assert.rejects(
      () =>
        loadEnrichmentEvidenceList(
          { env: {}, readArtifact },
          { fields: "not_a_column" },
        ),
      (err) => err.code === "invalid_params",
    );
  });

  test("loadEnrichmentEvidenceList projects row fields when requested", async () => {
    const out = await loadEnrichmentEvidenceList(
      { env: {}, readArtifact },
      { fields: "netuid,lane", limit: 1 },
    );
    assert.deepEqual(out.entries[0], { netuid: 7, lane: "direct-submission" });
  });

  test("loadEnrichmentEvidenceList omits nullable artifact metadata when absent", async () => {
    const out = await loadEnrichmentEvidenceList(
      {
        env: {},
        readArtifact: async () => ({
          ok: true,
          data: { entries: [{ netuid: 0, lane: "direct-submission" }] },
        }),
      },
      {},
    );
    assert.equal(out.generated_at, null);
    assert.equal(out.notes, null);
  });

  test("loadEnrichmentEvidenceList treats a non-array entries key as empty", async () => {
    const out = await loadEnrichmentEvidenceList(
      {
        env: {},
        readArtifact: async () => ({
          ok: true,
          data: { entries: null },
        }),
      },
      {},
    );
    assert.deepEqual(out.entries, []);
    assert.equal(out.total, 0);
  });

  test("loadEnrichmentEvidenceList falls back when pagination meta is absent", async () => {
    const spy = vi.spyOn(listQuery, "applyQueryFilters").mockReturnValue({
      data: { entries: [{ netuid: 9 }, { netuid: 10 }] },
      meta: {},
    });
    try {
      const out = await loadEnrichmentEvidenceList(
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

  test("loadEnrichmentEvidenceList rejects a malformed artifact payload", async () => {
    await assert.rejects(
      () =>
        loadEnrichmentEvidenceList(
          {
            env: {},
            readArtifact: async () => ({ ok: true, data: null }),
          },
          {},
        ),
      (err) => err.code === "not_found",
    );
  });

  test("loadEnrichmentEvidenceList defaults code when the read result is bare", async () => {
    await assert.rejects(
      () =>
        loadEnrichmentEvidenceList(
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
      LIST_ENRICHMENT_EVIDENCE_MCP_TOOL.name,
      "list_enrichment_evidence",
    );
    assert.match(
      LIST_ENRICHMENT_EVIDENCE_INSTRUCTIONS,
      /list_enrichment_evidence/,
    );
    assert.ok(
      new Ajv2020({ strict: false }).compile(
        LIST_ENRICHMENT_EVIDENCE_OUTPUT_SCHEMA,
      ),
    );
  });

  test("MCP server exports wire list_enrichment_evidence", () => {
    assert.match(MCP_INSTRUCTIONS, /list_enrichment_evidence/);
    const tool = MCP_TOOLS.find((t) => t.name === "list_enrichment_evidence");
    assert.ok(tool);
    assert.equal(tool.title, "List review enrichment evidence entries");
  });
});
