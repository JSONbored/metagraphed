import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import * as listQuery from "../workers/list-query.ts";
import {
  ENRICHMENT_QUEUE_ARTIFACT,
  LIST_ENRICHMENT_QUEUE_INSTRUCTIONS,
  LIST_ENRICHMENT_QUEUE_MCP_TOOL,
  LIST_ENRICHMENT_QUEUE_OUTPUT_SCHEMA,
  enrichmentQueueMcpError,
  enrichmentQueueQueryUrl,
  loadEnrichmentQueueList,
} from "../src/enrichment-queue-mcp.ts";
import { MCP_INSTRUCTIONS, MCP_TOOLS } from "../src/mcp-server.mjs";

const SAMPLE_BLOB = {
  generated_at: "2026-07-01T00:00:00.000Z",
  notes: ["review queue"],
  queue: [
    {
      netuid: 7,
      name: "Allways",
      lane: "direct-submission",
      priority_score: 88,
      missing_kinds: ["openapi"],
      direct_submission_kinds: ["openapi"],
    },
    {
      netuid: 12,
      name: "Compute",
      lane: "maintainer-review",
      priority_score: 72,
      missing_kinds: ["website"],
    },
  ],
};

function readArtifact(_env, path) {
  if (path === ENRICHMENT_QUEUE_ARTIFACT) {
    return Promise.resolve({ ok: true, data: SAMPLE_BLOB });
  }
  return Promise.resolve({ ok: false, code: "artifact_not_found" });
}

describe("enrichment-queue-mcp", () => {
  test("enrichmentQueueMcpError is shaped for MCP toolError handling", () => {
    const err = enrichmentQueueMcpError("invalid_params", "bad lane");
    assert.equal(err.code, "invalid_params");
    assert.equal(err.toolError, true);
  });

  test("enrichmentQueueQueryUrl validates filters and cursor", () => {
    const url = enrichmentQueueQueryUrl({
      q: "openapi",
      netuid: 7,
      lane: "direct-submission",
      evidence_action: "submit-new-evidence",
      identity_level: "partial",
      curation_level: "maintainer-reviewed",
      profile_level: "identity-partial",
      direct_submission_kinds: "openapi",
      missing_kinds: "openapi",
      manual_review_required: "true",
      reason_codes: "missing-openapi",
      review_state: "pending",
      sort: "priority_score",
      order: "desc",
      fields: "netuid,lane",
      limit: 10,
      cursor: 5,
    });
    assert.equal(url.searchParams.get("q"), "openapi");
    assert.equal(url.searchParams.get("netuid"), "7");
    assert.equal(url.searchParams.get("lane"), "direct-submission");
    assert.equal(url.searchParams.get("profile_level"), "identity-partial");
    assert.equal(url.searchParams.get("sort"), "priority_score");
    assert.equal(url.searchParams.get("limit"), "10");
    assert.equal(url.searchParams.get("cursor"), "5");
  });

  test("enrichmentQueueQueryUrl rejects invalid lane", () => {
    assert.throws(
      () => enrichmentQueueQueryUrl({ lane: "bogus" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("enrichmentQueueQueryUrl rejects invalid netuid", () => {
    assert.throws(
      () => enrichmentQueueQueryUrl({ netuid: -1 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("enrichmentQueueQueryUrl rejects empty q and invalid sort", () => {
    assert.throws(
      () => enrichmentQueueQueryUrl({ q: "   " }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => enrichmentQueueQueryUrl({ sort: "not_a_column" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("enrichmentQueueQueryUrl rejects non-string q and invalid order", () => {
    assert.throws(
      () => enrichmentQueueQueryUrl({ q: 42 }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => enrichmentQueueQueryUrl({ order: "sideways" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("enrichmentQueueQueryUrl rejects empty fields and non-string fields", () => {
    assert.throws(
      () => enrichmentQueueQueryUrl({ fields: "   " }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => enrichmentQueueQueryUrl({ fields: 42 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("enrichmentQueueQueryUrl trims and forwards a fields projection", () => {
    const url = enrichmentQueueQueryUrl({ fields: " netuid,lane " });
    assert.equal(url.searchParams.get("fields"), "netuid,lane");
  });

  test("enrichmentQueueQueryUrl clamps a non-numeric limit to the default", () => {
    const url = enrichmentQueueQueryUrl({ limit: "lots" });
    assert.equal(url.searchParams.get("limit"), "50");
  });

  test("enrichmentQueueQueryUrl clamps a sub-minimum numeric limit to the default", () => {
    const url = enrichmentQueueQueryUrl({ limit: 0 });
    assert.equal(url.searchParams.get("limit"), "50");
  });

  test("enrichmentQueueQueryUrl rejects a fractional netuid", () => {
    assert.throws(
      () => enrichmentQueueQueryUrl({ netuid: 1.5 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("enrichmentQueueQueryUrl rejects a fractional cursor", () => {
    assert.throws(
      () => enrichmentQueueQueryUrl({ cursor: 1.5 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("enrichmentQueueQueryUrl rejects negative cursor", () => {
    assert.throws(
      () => enrichmentQueueQueryUrl({ cursor: -1 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("enrichmentQueueQueryUrl clamps limit above the MCP maximum", () => {
    const url = enrichmentQueueQueryUrl({ limit: 500 });
    assert.equal(url.searchParams.get("limit"), "100");
  });

  test("loadEnrichmentQueueList returns filtered rows with pagination meta", async () => {
    const out = await loadEnrichmentQueueList(
      { env: {}, readArtifact },
      { lane: "direct-submission" },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.queue[0].netuid, 7);
    assert.equal(out.queue[0].priority_score, 88);
  });

  test("loadEnrichmentQueueList sorts and pages the collection", async () => {
    const out = await loadEnrichmentQueueList(
      { env: {}, readArtifact },
      { sort: "priority_score", order: "desc", limit: 1 },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.total, 2);
    assert.equal(out.queue[0].netuid, 7);
    assert.equal(out.next_cursor, 1);
  });

  test("loadEnrichmentQueueList uses an injected readArtifact dep", async () => {
    const out = await loadEnrichmentQueueList(
      { env: {}, readArtifact: async () => ({ ok: false }) },
      {},
      {
        readArtifact: async () => ({
          ok: true,
          data: { queue: [{ netuid: 0, lane: "monitoring-followup" }] },
        }),
      },
    );
    assert.equal(out.queue[0].netuid, 0);
  });

  test("loadEnrichmentQueueList maps artifact_not_found to not_found", async () => {
    await assert.rejects(
      () =>
        loadEnrichmentQueueList(
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

  test("loadEnrichmentQueueList surfaces other artifact failures", async () => {
    await assert.rejects(
      () =>
        loadEnrichmentQueueList(
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
        /enrichment-queue\.json/.test(err.message),
    );
  });

  test("loadEnrichmentQueueList rejects invalid list-query params from REST parity", async () => {
    await assert.rejects(
      () =>
        loadEnrichmentQueueList(
          { env: {}, readArtifact },
          { fields: "not_a_column" },
        ),
      (err) => err.code === "invalid_params",
    );
  });

  test("loadEnrichmentQueueList projects row fields when requested", async () => {
    const out = await loadEnrichmentQueueList(
      { env: {}, readArtifact },
      { fields: "netuid,lane", limit: 1 },
    );
    assert.deepEqual(out.queue[0], { netuid: 7, lane: "direct-submission" });
  });

  test("loadEnrichmentQueueList omits nullable artifact metadata when absent", async () => {
    const out = await loadEnrichmentQueueList(
      {
        env: {},
        readArtifact: async () => ({
          ok: true,
          data: { queue: [{ netuid: 0, lane: "direct-submission" }] },
        }),
      },
      {},
    );
    assert.equal(out.generated_at, null);
    assert.equal(out.notes, null);
  });

  test("loadEnrichmentQueueList treats a non-array queue key as empty", async () => {
    const out = await loadEnrichmentQueueList(
      {
        env: {},
        readArtifact: async () => ({
          ok: true,
          data: { queue: null },
        }),
      },
      {},
    );
    assert.deepEqual(out.queue, []);
    assert.equal(out.total, 0);
  });

  test("loadEnrichmentQueueList falls back when pagination meta is absent", async () => {
    const spy = vi.spyOn(listQuery, "applyQueryFilters").mockReturnValue({
      data: { queue: [{ netuid: 9 }, { netuid: 10 }] },
      meta: {},
    });
    try {
      const out = await loadEnrichmentQueueList({ env: {}, readArtifact }, {});
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

  test("loadEnrichmentQueueList rejects a malformed artifact payload", async () => {
    await assert.rejects(
      () =>
        loadEnrichmentQueueList(
          {
            env: {},
            readArtifact: async () => ({ ok: true, data: null }),
          },
          {},
        ),
      (err) => err.code === "not_found",
    );
  });

  test("loadEnrichmentQueueList defaults code when the read result is bare", async () => {
    await assert.rejects(
      () =>
        loadEnrichmentQueueList(
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
    assert.equal(LIST_ENRICHMENT_QUEUE_MCP_TOOL.name, "list_enrichment_queue");
    assert.match(LIST_ENRICHMENT_QUEUE_INSTRUCTIONS, /list_enrichment_queue/);
    assert.ok(
      new Ajv2020({ strict: false }).compile(
        LIST_ENRICHMENT_QUEUE_OUTPUT_SCHEMA,
      ),
    );
  });

  test("MCP server exports wire list_enrichment_queue", () => {
    assert.match(MCP_INSTRUCTIONS, /list_enrichment_queue/);
    const tool = MCP_TOOLS.find((t) => t.name === "list_enrichment_queue");
    assert.ok(tool);
    assert.equal(tool.title, "List review enrichment queue entries");
  });
});
