import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import * as listQuery from "../workers/list-query.ts";
import {
  LIST_REVIEW_ENRICHMENT_TARGETS_INSTRUCTIONS,
  LIST_REVIEW_ENRICHMENT_TARGETS_MCP_TOOL,
  LIST_REVIEW_ENRICHMENT_TARGETS_OUTPUT_SCHEMA,
  REVIEW_ENRICHMENT_TARGETS_ARTIFACT,
  loadReviewEnrichmentTargetsList,
  reviewEnrichmentTargetsMcpError,
  reviewEnrichmentTargetsQueryUrl,
} from "../src/review-enrichment-targets-mcp.ts";
import type { Row } from "./row-type.ts";

type LoadCtx = Parameters<typeof loadReviewEnrichmentTargetsList>[0];
type LoadDeps = Parameters<typeof loadReviewEnrichmentTargetsList>[2];

import { MCP_INSTRUCTIONS, MCP_TOOLS } from "../src/mcp-server.mjs";

const SAMPLE_BLOB = {
  generated_at: "2026-07-01T00:00:00.000Z",
  notes: ["enrichment target drill-down"],
  targets: [
    {
      netuid: 7,
      name: "Allways",
      target_type: "surface-candidate",
      target_action: "submit-new-candidate",
      lane: "direct-submission",
      kind: "openapi",
      priority_score: 88,
      missing_kinds: ["openapi"],
      submission_route: "direct-candidate-pr",
    },
    {
      netuid: 12,
      name: "Compute",
      target_type: "maintainer-review",
      target_action: "maintainer-review",
      lane: "maintainer-review",
      kind: "website",
      priority_score: 72,
      missing_kinds: ["website"],
      submission_route: "maintainer-review",
    },
  ],
};

function readArtifact(_env: unknown, path: string) {
  if (path === REVIEW_ENRICHMENT_TARGETS_ARTIFACT) {
    return Promise.resolve({ ok: true, data: SAMPLE_BLOB });
  }
  return Promise.resolve({ ok: false, code: "artifact_not_found" });
}

describe("review-enrichment-targets-mcp", () => {
  test("reviewEnrichmentTargetsMcpError is shaped for MCP toolError handling", () => {
    const err = reviewEnrichmentTargetsMcpError("invalid_params", "bad lane");
    assert.equal(err.code, "invalid_params");
    assert.equal(err.toolError, true);
  });

  test("reviewEnrichmentTargetsQueryUrl validates filters and cursor", () => {
    const url = reviewEnrichmentTargetsQueryUrl({
      q: "openapi",
      netuid: 7,
      target_type: "surface-candidate",
      target_action: "submit-new-candidate",
      kind: "openapi",
      lane: "direct-submission",
      evidence_action: "replace-stale-evidence",
      identity_level: "partial",
      profile_level: "identity-partial",
      submission_route: "direct-candidate-pr",
      auto_review_candidate: "true",
      manual_review_required: "false",
      missing_kinds: "openapi",
      reason_codes: "missing-openapi",
      sort: "priority_score",
      order: "desc",
      fields: "netuid,lane",
      limit: 10,
      cursor: 5,
    });
    assert.equal(url.searchParams.get("q"), "openapi");
    assert.equal(url.searchParams.get("netuid"), "7");
    assert.equal(url.searchParams.get("target_type"), "surface-candidate");
    assert.equal(url.searchParams.get("target_action"), "submit-new-candidate");
    assert.equal(url.searchParams.get("kind"), "openapi");
    assert.equal(url.searchParams.get("lane"), "direct-submission");
    assert.equal(
      url.searchParams.get("evidence_action"),
      "replace-stale-evidence",
    );
    assert.equal(url.searchParams.get("profile_level"), "identity-partial");
    assert.equal(url.searchParams.get("auto_review_candidate"), "true");
    assert.equal(url.searchParams.get("sort"), "priority_score");
    assert.equal(url.searchParams.get("limit"), "10");
    assert.equal(url.searchParams.get("cursor"), "5");
  });

  test("reviewEnrichmentTargetsQueryUrl rejects invalid target_type", () => {
    assert.throws(
      () => reviewEnrichmentTargetsQueryUrl({ target_type: "bogus" }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("reviewEnrichmentTargetsQueryUrl rejects invalid target_action", () => {
    assert.throws(
      () => reviewEnrichmentTargetsQueryUrl({ target_action: "bogus" }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("reviewEnrichmentTargetsQueryUrl rejects invalid lane", () => {
    assert.throws(
      () => reviewEnrichmentTargetsQueryUrl({ lane: "bogus" }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("reviewEnrichmentTargetsQueryUrl rejects invalid netuid", () => {
    assert.throws(
      () => reviewEnrichmentTargetsQueryUrl({ netuid: -1 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("reviewEnrichmentTargetsQueryUrl rejects empty q and invalid sort", () => {
    assert.throws(
      () => reviewEnrichmentTargetsQueryUrl({ q: "   " }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => reviewEnrichmentTargetsQueryUrl({ sort: "not_a_column" }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("reviewEnrichmentTargetsQueryUrl rejects non-string q and invalid order", () => {
    assert.throws(
      () => reviewEnrichmentTargetsQueryUrl({ q: 42 }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => reviewEnrichmentTargetsQueryUrl({ order: "sideways" }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("reviewEnrichmentTargetsQueryUrl rejects empty fields and non-string fields", () => {
    assert.throws(
      () => reviewEnrichmentTargetsQueryUrl({ fields: "   " }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => reviewEnrichmentTargetsQueryUrl({ fields: 42 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("reviewEnrichmentTargetsQueryUrl trims and forwards a fields projection", () => {
    const url = reviewEnrichmentTargetsQueryUrl({ fields: " netuid,lane " });
    assert.equal(url.searchParams.get("fields"), "netuid,lane");
  });

  test("reviewEnrichmentTargetsQueryUrl clamps a non-numeric limit to the default", () => {
    const url = reviewEnrichmentTargetsQueryUrl({ limit: "lots" });
    assert.equal(url.searchParams.get("limit"), "50");
  });

  test("reviewEnrichmentTargetsQueryUrl clamps a sub-minimum numeric limit to the default", () => {
    const url = reviewEnrichmentTargetsQueryUrl({ limit: 0 });
    assert.equal(url.searchParams.get("limit"), "50");
  });

  test("reviewEnrichmentTargetsQueryUrl rejects a fractional netuid", () => {
    assert.throws(
      () => reviewEnrichmentTargetsQueryUrl({ netuid: 1.5 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("reviewEnrichmentTargetsQueryUrl rejects a fractional cursor", () => {
    assert.throws(
      () => reviewEnrichmentTargetsQueryUrl({ cursor: 1.5 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("reviewEnrichmentTargetsQueryUrl rejects negative cursor", () => {
    assert.throws(
      () => reviewEnrichmentTargetsQueryUrl({ cursor: -1 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("reviewEnrichmentTargetsQueryUrl clamps limit above the MCP maximum", () => {
    const url = reviewEnrichmentTargetsQueryUrl({ limit: 500 });
    assert.equal(url.searchParams.get("limit"), "100");
  });

  test("loadReviewEnrichmentTargetsList returns filtered rows with pagination meta", async () => {
    const out = await loadReviewEnrichmentTargetsList(
      { env: {}, readArtifact } as unknown as LoadCtx,
      { target_type: "surface-candidate" },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.targets[0].netuid, 7);
    assert.equal(out.targets[0].target_action, "submit-new-candidate");
  });

  test("loadReviewEnrichmentTargetsList sorts and pages the collection", async () => {
    const out = await loadReviewEnrichmentTargetsList(
      { env: {}, readArtifact } as unknown as LoadCtx,
      { sort: "priority_score", order: "desc", limit: 1 },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.total, 2);
    assert.equal(out.targets[0].netuid, 7);
    assert.equal(out.next_cursor, 1);
  });

  test("loadReviewEnrichmentTargetsList uses an injected readArtifact dep", async () => {
    const out = await loadReviewEnrichmentTargetsList(
      {
        env: {},
        readArtifact: async () => ({ ok: false }),
      } as unknown as LoadCtx,
      {},
      {
        readArtifact: async () => ({
          ok: true,
          data: {
            targets: [{ netuid: 0, lane: "monitoring-followup" }],
          },
        }),
      } as unknown as LoadDeps,
    );
    assert.equal(out.targets[0].netuid, 0);
  });

  test("loadReviewEnrichmentTargetsList maps artifact_not_found to not_found", async () => {
    await assert.rejects(
      () =>
        loadReviewEnrichmentTargetsList(
          {
            env: {},
            readArtifact: async () => ({
              ok: false,
              code: "artifact_not_found",
            }),
          } as unknown as LoadCtx,
          {},
        ),
      (err: Row) => err.code === "not_found",
    );
  });

  test("loadReviewEnrichmentTargetsList surfaces other artifact failures", async () => {
    await assert.rejects(
      () =>
        loadReviewEnrichmentTargetsList(
          {
            env: {},
            readArtifact: async () => ({
              ok: false,
              code: "artifact_timeout",
            }),
          } as unknown as LoadCtx,
          {},
        ),
      (err: Row) =>
        err.code === "artifact_timeout" &&
        /enrichment-targets\.json/.test(err.message),
    );
  });

  test("loadReviewEnrichmentTargetsList rejects invalid list-query params from REST parity", async () => {
    await assert.rejects(
      () =>
        loadReviewEnrichmentTargetsList(
          { env: {}, readArtifact } as unknown as LoadCtx,
          { fields: "not_a_column" },
        ),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("loadReviewEnrichmentTargetsList projects row fields when requested", async () => {
    const out = await loadReviewEnrichmentTargetsList(
      { env: {}, readArtifact } as unknown as LoadCtx,
      { fields: "netuid,lane", limit: 1 },
    );
    assert.deepEqual(out.targets[0], { netuid: 7, lane: "direct-submission" });
  });

  test("loadReviewEnrichmentTargetsList omits nullable artifact metadata when absent", async () => {
    const out = await loadReviewEnrichmentTargetsList(
      {
        env: {},
        readArtifact: async () => ({
          ok: true,
          data: { targets: [{ netuid: 0, lane: "direct-submission" }] },
        }),
      } as unknown as LoadCtx,
      {},
    );
    assert.equal(out.generated_at, null);
    assert.equal(out.notes, null);
  });

  test("loadReviewEnrichmentTargetsList treats a non-array targets key as empty", async () => {
    const out = await loadReviewEnrichmentTargetsList(
      {
        env: {},
        readArtifact: async () => ({
          ok: true,
          data: { targets: null },
        }),
      } as unknown as LoadCtx,
      {},
    );
    assert.deepEqual(out.targets, []);
    assert.equal(out.total, 0);
  });

  test("loadReviewEnrichmentTargetsList falls back when pagination meta is absent", async () => {
    const spy = vi.spyOn(listQuery, "applyQueryFilters").mockReturnValue({
      data: { targets: [{ netuid: 9 }, { netuid: 10 }] },
      meta: {},
    });
    try {
      const out = await loadReviewEnrichmentTargetsList(
        { env: {}, readArtifact } as unknown as LoadCtx,
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

  test("loadReviewEnrichmentTargetsList rejects a malformed artifact payload", async () => {
    await assert.rejects(
      () =>
        loadReviewEnrichmentTargetsList(
          {
            env: {},
            readArtifact: async () => ({ ok: true, data: null }),
          } as unknown as LoadCtx,
          {},
        ),
      (err: Row) => err.code === "not_found",
    );
  });

  test("loadReviewEnrichmentTargetsList defaults code when the read result is bare", async () => {
    await assert.rejects(
      () =>
        loadReviewEnrichmentTargetsList(
          {
            env: {},
            readArtifact: async () => ({ ok: false }),
          } as unknown as LoadCtx,
          {},
        ),
      (err: Row) => err.code === "artifact_unavailable",
    );
  });

  test("MCP tool metadata and outputSchema compile", () => {
    assert.equal(
      LIST_REVIEW_ENRICHMENT_TARGETS_MCP_TOOL.name,
      "list_review_enrichment_targets",
    );
    assert.match(
      LIST_REVIEW_ENRICHMENT_TARGETS_INSTRUCTIONS,
      /list_review_enrichment_targets/,
    );
    assert.ok(
      new Ajv2020({ strict: false }).compile(
        LIST_REVIEW_ENRICHMENT_TARGETS_OUTPUT_SCHEMA,
      ),
    );
  });

  test("MCP server exports wire list_review_enrichment_targets", () => {
    assert.match(MCP_INSTRUCTIONS, /list_review_enrichment_targets/);
    const tool = MCP_TOOLS.find(
      (t) => t.name === "list_review_enrichment_targets",
    );
    assert.ok(tool);
    assert.equal(tool.title, "List review enrichment targets");
  });
});
