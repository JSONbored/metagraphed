import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import * as listQuery from "../workers/list-query.ts";
import {
  CANDIDATES_ARTIFACT,
  LIST_CANDIDATES_INSTRUCTIONS,
  LIST_CANDIDATES_MCP_TOOL,
  LIST_CANDIDATES_OUTPUT_SCHEMA,
  candidatesMcpError,
  candidatesQueryUrl,
  loadCandidatesList,
} from "../src/candidates-mcp.ts";
import { MCP_INSTRUCTIONS, MCP_TOOLS } from "../src/mcp-server.ts";
import type { Row } from "./row-type.ts";

type CandidatesCtx = Parameters<typeof loadCandidatesList>[0];
type CandidatesDeps = Parameters<typeof loadCandidatesList>[2];

const SAMPLE_BLOB = {
  generated_at: "2026-07-01T00:00:00.000Z",
  notes: "test",
  candidates: [
    {
      id: "sn-7-openapi",
      netuid: 7,
      kind: "openapi",
      provider: "datura",
      state: "verified",
      confidence: "high",
      name: "OpenAPI",
    },
    {
      id: "sn-7-website",
      netuid: 7,
      kind: "website",
      provider: "datura",
      state: "schema-valid",
      confidence: "low",
      name: "Website",
    },
    {
      id: "sn-12-openapi",
      netuid: 12,
      kind: "openapi",
      provider: "chutes",
      state: "stale",
      confidence: "medium",
      name: "OpenAPI",
    },
  ],
};

function readArtifact(_env: unknown, path: string) {
  if (path === CANDIDATES_ARTIFACT) {
    return Promise.resolve({ ok: true, data: SAMPLE_BLOB });
  }
  return Promise.resolve({ ok: false, code: "artifact_not_found" });
}

describe("candidates-mcp (#7889)", () => {
  test("candidatesMcpError is shaped for MCP toolError handling", () => {
    const err = candidatesMcpError("invalid_params", "bad sort");
    assert.equal(err.code, "invalid_params");
    assert.equal(err.toolError, true);
  });

  test("candidatesQueryUrl validates filters and cursor", () => {
    const url = candidatesQueryUrl({
      netuid: 7,
      kind: "openapi",
      provider: "datura",
      state: "verified",
      id: "sn-7-openapi",
      confidence: "high",
      sort: "confidence",
      order: "desc",
      limit: 10,
      cursor: 5,
    });
    assert.equal(url.searchParams.get("netuid"), "7");
    assert.equal(url.searchParams.get("kind"), "openapi");
    assert.equal(url.searchParams.get("provider"), "datura");
    assert.equal(url.searchParams.get("state"), "verified");
    assert.equal(url.searchParams.get("id"), "sn-7-openapi");
    assert.equal(url.searchParams.get("confidence"), "high");
    assert.equal(url.searchParams.get("sort"), "confidence");
    assert.equal(url.searchParams.get("order"), "desc");
    assert.equal(url.searchParams.get("limit"), "10");
    assert.equal(url.searchParams.get("cursor"), "5");
  });

  test("candidatesQueryUrl rejects invalid confidence", () => {
    assert.throws(
      () => candidatesQueryUrl({ confidence: "extreme" }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("candidatesQueryUrl rejects invalid kind", () => {
    assert.throws(
      () => candidatesQueryUrl({ kind: "bogus" }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("candidatesQueryUrl rejects invalid state", () => {
    assert.throws(
      () => candidatesQueryUrl({ state: "bogus" }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("candidatesQueryUrl rejects invalid netuid", () => {
    assert.throws(
      () => candidatesQueryUrl({ netuid: -1 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("candidatesQueryUrl rejects empty fields projection", () => {
    assert.throws(
      () => candidatesQueryUrl({ fields: "   " }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("candidatesQueryUrl rejects negative cursor", () => {
    assert.throws(
      () => candidatesQueryUrl({ cursor: -1 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("candidatesQueryUrl rejects non-string fields", () => {
    assert.throws(
      () => candidatesQueryUrl({ fields: 42 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("candidatesQueryUrl trims and forwards a fields projection", () => {
    const url = candidatesQueryUrl({ fields: " id,confidence " });
    assert.equal(url.searchParams.get("fields"), "id,confidence");
  });

  test("candidatesQueryUrl rejects a non-numeric limit", () => {
    assert.throws(
      () => candidatesQueryUrl({ limit: "lots" }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("candidatesQueryUrl rejects a sub-minimum limit", () => {
    assert.throws(
      () => candidatesQueryUrl({ limit: 0 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("candidatesQueryUrl rejects a limit above the MCP maximum", () => {
    assert.throws(
      () => candidatesQueryUrl({ limit: 1001 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("candidatesQueryUrl rejects a fractional netuid", () => {
    assert.throws(
      () => candidatesQueryUrl({ netuid: 1.5 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("candidatesQueryUrl rejects non-string provider", () => {
    assert.throws(
      () => candidatesQueryUrl({ provider: 12 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("candidatesQueryUrl rejects invalid sort", () => {
    assert.throws(
      () => candidatesQueryUrl({ sort: "bogus" }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("loadCandidatesList filters by id", async () => {
    const out = await loadCandidatesList(
      { env: {}, readArtifact } as unknown as CandidatesCtx,
      { id: "SN-7-WEBSITE" },
    );
    assert.equal(out.total, 1);
    assert.equal(out.candidates[0].id, "sn-7-website");
  });

  test("loadCandidatesList filters by confidence", async () => {
    const out = await loadCandidatesList(
      { env: {}, readArtifact } as unknown as CandidatesCtx,
      { confidence: "medium" },
    );
    assert.equal(out.total, 1);
    assert.equal(out.candidates[0].id, "sn-12-openapi");
  });

  test("loadCandidatesList returns filtered rows with pagination meta", async () => {
    const out = await loadCandidatesList(
      { env: {}, readArtifact } as unknown as CandidatesCtx,
      { netuid: 7 },
    );
    assert.equal(out.returned, 2);
    assert.equal(out.candidates[0].netuid, 7);
  });

  test("loadCandidatesList sorts and pages the collection", async () => {
    const out = await loadCandidatesList(
      { env: {}, readArtifact } as unknown as CandidatesCtx,
      { sort: "confidence", order: "desc", limit: 1 },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.total, 3);
    assert.equal(out.candidates[0].confidence, "medium");
    assert.equal(out.next_cursor, 1);
  });

  test("loadCandidatesList uses an injected readArtifact dep", async () => {
    const out = await loadCandidatesList(
      {
        env: {},
        readArtifact: async () => ({ ok: false }),
      } as unknown as CandidatesCtx,
      {},
      {
        readArtifact: async () => ({
          ok: true,
          data: { candidates: [{ id: "injected", netuid: 0 }] },
        }),
      } as unknown as CandidatesDeps,
    );
    assert.equal(out.candidates[0].id, "injected");
  });

  test("loadCandidatesList maps artifact_not_found to not_found", async () => {
    await assert.rejects(
      () =>
        loadCandidatesList(
          {
            env: {},
            readArtifact: async () => ({
              ok: false,
              code: "artifact_not_found",
            }),
          } as unknown as CandidatesCtx,
          {},
        ),
      (err: Row) => err.code === "not_found",
    );
  });

  test("loadCandidatesList surfaces other artifact failures", async () => {
    await assert.rejects(
      () =>
        loadCandidatesList(
          {
            env: {},
            readArtifact: async () => ({
              ok: false,
              code: "artifact_timeout",
            }),
          } as unknown as CandidatesCtx,
          {},
        ),
      (err: Row) =>
        err.code === "artifact_timeout" && /candidates\.json/.test(err.message),
    );
  });

  test("loadCandidatesList rejects invalid list-query params from REST parity", async () => {
    await assert.rejects(
      () =>
        loadCandidatesList(
          { env: {}, readArtifact } as unknown as CandidatesCtx,
          {
            fields: "not_a_column",
          },
        ),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("loadCandidatesList projects row fields when requested", async () => {
    const out = await loadCandidatesList(
      { env: {}, readArtifact } as unknown as CandidatesCtx,
      { fields: "id,confidence", limit: 1 },
    );
    assert.deepEqual(out.candidates[0], {
      id: "sn-7-openapi",
      confidence: "high",
    });
  });

  test("loadCandidatesList omits nullable artifact metadata when absent", async () => {
    const out = await loadCandidatesList(
      {
        env: {},
        readArtifact: async () => ({
          ok: true,
          data: { candidates: [{ id: "x", netuid: 0 }] },
        }),
      } as unknown as CandidatesCtx,
      {},
    );
    assert.equal(out.generated_at, null);
    assert.equal(out.notes, null);
  });

  test("loadCandidatesList treats a non-array candidates key as empty", async () => {
    const out = await loadCandidatesList(
      {
        env: {},
        readArtifact: async () => ({
          ok: true,
          data: { candidates: null },
        }),
      } as unknown as CandidatesCtx,
      {},
    );
    assert.deepEqual(out.candidates, []);
    assert.equal(out.total, 0);
  });

  test("loadCandidatesList falls back when pagination meta is absent", async () => {
    const spy = vi.spyOn(listQuery, "applyQueryFilters").mockReturnValue({
      data: {
        candidates: [
          { id: "a", netuid: 9 },
          { id: "b", netuid: 10 },
        ],
      },
      meta: undefined,
    });
    try {
      const out = await loadCandidatesList(
        { env: {}, readArtifact } as unknown as CandidatesCtx,
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

  test("loadCandidatesList rejects a malformed artifact payload", async () => {
    await assert.rejects(
      () =>
        loadCandidatesList(
          {
            env: {},
            readArtifact: async () => ({ ok: true, data: null }),
          } as unknown as CandidatesCtx,
          {},
        ),
      (err: Row) => err.code === "not_found",
    );
  });

  test("loadCandidatesList defaults code when the read result is bare", async () => {
    await assert.rejects(
      () =>
        loadCandidatesList(
          {
            env: {},
            readArtifact: async () => ({ ok: false }),
          } as unknown as CandidatesCtx,
          {},
        ),
      (err: Row) => err.code === "artifact_unavailable",
    );
  });

  test("MCP tool metadata and outputSchema compile", () => {
    assert.equal(LIST_CANDIDATES_MCP_TOOL.name, "list_candidates");
    assert.match(LIST_CANDIDATES_INSTRUCTIONS, /list_candidates/);
    assert.ok(
      new Ajv2020({ strict: false }).compile(LIST_CANDIDATES_OUTPUT_SCHEMA),
    );
  });

  test("MCP server exports wire list_candidates with new filters", () => {
    assert.match(MCP_INSTRUCTIONS, /list_candidates/);
    assert.match(LIST_CANDIDATES_INSTRUCTIONS, /id\/confidence/);
    const tool = MCP_TOOLS.find((t: Row) => t.name === "list_candidates");
    assert.ok(tool);
    assert.equal(tool.name, LIST_CANDIDATES_MCP_TOOL.name);
    assert.equal(tool.title, "List unpromoted candidate surfaces");
    assert.ok(LIST_CANDIDATES_MCP_TOOL.inputSchema.properties.id);
    assert.ok(LIST_CANDIDATES_MCP_TOOL.inputSchema.properties.confidence);
    assert.ok(LIST_CANDIDATES_MCP_TOOL.inputSchema.properties.sort);
    assert.ok(LIST_CANDIDATES_MCP_TOOL.inputSchema.properties.order);
  });
});
