import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import * as listQuery from "../workers/list-query.ts";
import {
  LIST_REVIEW_GAPS_INSTRUCTIONS,
  LIST_REVIEW_GAPS_MCP_TOOL,
  LIST_REVIEW_GAPS_OUTPUT_SCHEMA,
  REVIEW_GAPS_ARTIFACT,
  loadReviewGapsList,
  reviewGapsMcpError,
  reviewGapsQueryUrl,
} from "../src/review-gaps-mcp.ts";
import { MCP_INSTRUCTIONS, MCP_TOOLS } from "../src/mcp-server.mjs";

const SAMPLE_BLOB = {
  generated_at: "2026-07-01T00:00:00.000Z",
  notes: ["gap priorities"],
  priorities: [
    {
      netuid: 7,
      name: "Allways",
      priority_score: 88,
      curation_level: "candidate-discovered",
      review_state: "needs-evidence",
      missing_kinds: ["openapi"],
    },
    {
      netuid: 12,
      name: "Compute",
      priority_score: 72,
      curation_level: "maintainer-reviewed",
      review_state: "accepted",
      missing_kinds: ["website"],
    },
  ],
};

function readArtifact(_env, path) {
  if (path === REVIEW_GAPS_ARTIFACT) {
    return Promise.resolve({ ok: true, data: SAMPLE_BLOB });
  }
  return Promise.resolve({ ok: false, code: "artifact_not_found" });
}

describe("review-gaps-mcp", () => {
  test("reviewGapsMcpError is shaped for MCP toolError handling", () => {
    const err = reviewGapsMcpError("invalid_params", "bad sort");
    assert.equal(err.code, "invalid_params");
    assert.equal(err.toolError, true);
  });

  test("reviewGapsQueryUrl validates filters and cursor", () => {
    const url = reviewGapsQueryUrl({
      netuid: 7,
      curation_level: "candidate-discovered",
      missing_kinds: "openapi",
      review_state: "needs-evidence",
      sort: "priority_score",
      order: "desc",
      fields: "netuid,priority_score",
      limit: 10,
      cursor: 5,
    });
    assert.equal(url.searchParams.get("netuid"), "7");
    assert.equal(
      url.searchParams.get("curation_level"),
      "candidate-discovered",
    );
    assert.equal(url.searchParams.get("missing_kinds"), "openapi");
    assert.equal(url.searchParams.get("review_state"), "needs-evidence");
    assert.equal(url.searchParams.get("sort"), "priority_score");
    assert.equal(url.searchParams.get("limit"), "10");
    assert.equal(url.searchParams.get("cursor"), "5");
  });

  test("reviewGapsQueryUrl rejects invalid curation_level", () => {
    assert.throws(
      () => reviewGapsQueryUrl({ curation_level: "bogus" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("reviewGapsQueryUrl rejects invalid netuid", () => {
    assert.throws(
      () => reviewGapsQueryUrl({ netuid: -1 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("reviewGapsQueryUrl rejects invalid sort", () => {
    assert.throws(
      () => reviewGapsQueryUrl({ sort: "not_a_column" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("reviewGapsQueryUrl rejects non-string fields and invalid order", () => {
    assert.throws(
      () => reviewGapsQueryUrl({ fields: 42 }),
      (err) => err.code === "invalid_params",
    );
    assert.throws(
      () => reviewGapsQueryUrl({ order: "sideways" }),
      (err) => err.code === "invalid_params",
    );
  });

  test("reviewGapsQueryUrl rejects empty fields projection", () => {
    assert.throws(
      () => reviewGapsQueryUrl({ fields: "   " }),
      (err) => err.code === "invalid_params",
    );
  });

  test("reviewGapsQueryUrl rejects empty review_state", () => {
    assert.throws(
      () => reviewGapsQueryUrl({ review_state: "   " }),
      (err) => err.code === "invalid_params",
    );
  });

  test("reviewGapsQueryUrl trims and forwards a fields projection", () => {
    const url = reviewGapsQueryUrl({ fields: " netuid,priority_score " });
    assert.equal(url.searchParams.get("fields"), "netuid,priority_score");
  });

  test("reviewGapsQueryUrl clamps a non-numeric limit to the default", () => {
    const url = reviewGapsQueryUrl({ limit: "lots" });
    assert.equal(url.searchParams.get("limit"), "50");
  });

  test("reviewGapsQueryUrl clamps a sub-minimum numeric limit to the default", () => {
    const url = reviewGapsQueryUrl({ limit: 0 });
    assert.equal(url.searchParams.get("limit"), "50");
  });

  test("reviewGapsQueryUrl rejects a fractional netuid", () => {
    assert.throws(
      () => reviewGapsQueryUrl({ netuid: 1.5 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("reviewGapsQueryUrl rejects a fractional cursor", () => {
    assert.throws(
      () => reviewGapsQueryUrl({ cursor: 1.5 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("reviewGapsQueryUrl rejects negative cursor", () => {
    assert.throws(
      () => reviewGapsQueryUrl({ cursor: -1 }),
      (err) => err.code === "invalid_params",
    );
  });

  test("reviewGapsQueryUrl clamps limit above the MCP maximum", () => {
    const url = reviewGapsQueryUrl({ limit: 500 });
    assert.equal(url.searchParams.get("limit"), "100");
  });

  test("loadReviewGapsList returns filtered rows with pagination meta", async () => {
    const out = await loadReviewGapsList(
      { env: {}, readArtifact },
      { curation_level: "candidate-discovered" },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.priorities[0].netuid, 7);
    assert.equal(out.priorities[0].priority_score, 88);
  });

  test("loadReviewGapsList sorts and pages the collection", async () => {
    const out = await loadReviewGapsList(
      { env: {}, readArtifact },
      { sort: "priority_score", order: "desc", limit: 1 },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.total, 2);
    assert.equal(out.priorities[0].netuid, 7);
    assert.equal(out.next_cursor, 1);
  });

  test("loadReviewGapsList uses an injected readArtifact dep", async () => {
    const out = await loadReviewGapsList(
      { env: {}, readArtifact: async () => ({ ok: false }) },
      {},
      {
        readArtifact: async () => ({
          ok: true,
          data: { priorities: [{ netuid: 0, priority_score: 1 }] },
        }),
      },
    );
    assert.equal(out.priorities[0].netuid, 0);
  });

  test("loadReviewGapsList maps artifact_not_found to not_found", async () => {
    await assert.rejects(
      () =>
        loadReviewGapsList(
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

  test("loadReviewGapsList surfaces other artifact failures", async () => {
    await assert.rejects(
      () =>
        loadReviewGapsList(
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
        /gap-priorities\.json/.test(err.message),
    );
  });

  test("loadReviewGapsList rejects invalid list-query params from REST parity", async () => {
    await assert.rejects(
      () =>
        loadReviewGapsList(
          { env: {}, readArtifact },
          { fields: "not_a_column" },
        ),
      (err) => err.code === "invalid_params",
    );
  });

  test("loadReviewGapsList projects row fields when requested", async () => {
    const out = await loadReviewGapsList(
      { env: {}, readArtifact },
      { fields: "netuid,priority_score", limit: 1 },
    );
    assert.deepEqual(out.priorities[0], { netuid: 7, priority_score: 88 });
  });

  test("loadReviewGapsList omits nullable artifact metadata when absent", async () => {
    const out = await loadReviewGapsList(
      {
        env: {},
        readArtifact: async () => ({
          ok: true,
          data: { priorities: [{ netuid: 0, priority_score: 1 }] },
        }),
      },
      {},
    );
    assert.equal(out.generated_at, null);
    assert.equal(out.notes, null);
  });

  test("loadReviewGapsList treats a non-array priorities key as empty", async () => {
    const out = await loadReviewGapsList(
      {
        env: {},
        readArtifact: async () => ({
          ok: true,
          data: { priorities: null },
        }),
      },
      {},
    );
    assert.deepEqual(out.priorities, []);
    assert.equal(out.total, 0);
  });

  test("loadReviewGapsList falls back when pagination meta is absent", async () => {
    const spy = vi.spyOn(listQuery, "applyQueryFilters").mockReturnValue({
      data: { priorities: [{ netuid: 9 }, { netuid: 10 }] },
      meta: {},
    });
    try {
      const out = await loadReviewGapsList({ env: {}, readArtifact }, {});
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

  test("loadReviewGapsList rejects a malformed artifact payload", async () => {
    await assert.rejects(
      () =>
        loadReviewGapsList(
          {
            env: {},
            readArtifact: async () => ({ ok: true, data: null }),
          },
          {},
        ),
      (err) => err.code === "not_found",
    );
  });

  test("loadReviewGapsList defaults code when the read result is bare", async () => {
    await assert.rejects(
      () =>
        loadReviewGapsList(
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
    assert.equal(LIST_REVIEW_GAPS_MCP_TOOL.name, "list_review_gaps");
    assert.match(LIST_REVIEW_GAPS_INSTRUCTIONS, /list_review_gaps/);
    assert.ok(
      new Ajv2020({ strict: false }).compile(LIST_REVIEW_GAPS_OUTPUT_SCHEMA),
    );
  });

  test("MCP server exports wire list_review_gaps", () => {
    assert.match(MCP_INSTRUCTIONS, /list_review_gaps/);
    const tool = MCP_TOOLS.find((t) => t.name === "list_review_gaps");
    assert.ok(tool);
    assert.equal(tool.title, "List review gap priorities");
  });
});
