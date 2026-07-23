import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import * as listQuery from "../workers/list-query.ts";
import {
  ADAPTER_CANDIDATES_ARTIFACT,
  LIST_ADAPTER_CANDIDATES_INSTRUCTIONS,
  LIST_ADAPTER_CANDIDATES_MCP_TOOL,
  LIST_ADAPTER_CANDIDATES_OUTPUT_SCHEMA,
  adapterCandidatesMcpError,
  adapterCandidatesQueryUrl,
  loadAdapterCandidatesList,
} from "../src/adapter-candidates-mcp.ts";
import { MCP_INSTRUCTIONS, MCP_TOOLS } from "../src/mcp-server.mjs";
import type { StorageReadResult } from "../workers/storage.ts";
import { mockEnv, type AnyFn, type Row } from "./row-type.ts";

type ReadArtifact = (env: Env, path: string) => Promise<StorageReadResult>;

const SAMPLE_BLOB = {
  generated_at: "2026-07-01T00:00:00.000Z",
  notes: ["adapter shortlist"],
  candidates: [
    {
      netuid: 7,
      name: "Allways",
      priority_score: 88,
      operational_kinds: ["openapi"],
      recommended_adapter_kind: "generic-openapi-or-custom",
      reason_codes: ["existing-adapter"],
    },
    {
      netuid: 12,
      name: "Compute",
      priority_score: 72,
      operational_kinds: ["website"],
      recommended_adapter_kind: "custom-adapter",
      reason_codes: ["missing-adapter"],
    },
  ],
};

const readArtifact = ((_env: Row, path: string) => {
  if (path === ADAPTER_CANDIDATES_ARTIFACT) {
    return Promise.resolve({ ok: true, data: SAMPLE_BLOB });
  }
  return Promise.resolve({ ok: false, code: "artifact_not_found" });
}) as unknown as ReadArtifact;

describe("adapter-candidates-mcp", () => {
  test("adapterCandidatesMcpError is shaped for MCP toolError handling", () => {
    const err = adapterCandidatesMcpError("invalid_params", "bad sort");
    assert.equal(err.code, "invalid_params");
    assert.equal(err.toolError, true);
  });

  test("adapterCandidatesQueryUrl validates filters and cursor", () => {
    const url = adapterCandidatesQueryUrl({
      netuid: 7,
      curation_level: "maintainer-reviewed",
      candidate_api_kinds: "openapi",
      operational_kinds: "openapi",
      recommended_adapter_kind: "generic-openapi-or-custom",
      reason_codes: "existing-adapter",
      sort: "priority_score",
      order: "desc",
      fields: "netuid,priority_score",
      limit: 10,
      cursor: 5,
    });
    assert.equal(url.searchParams.get("netuid"), "7");
    assert.equal(url.searchParams.get("operational_kinds"), "openapi");
    assert.equal(
      url.searchParams.get("recommended_adapter_kind"),
      "generic-openapi-or-custom",
    );
    assert.equal(url.searchParams.get("sort"), "priority_score");
    assert.equal(url.searchParams.get("limit"), "10");
    assert.equal(url.searchParams.get("cursor"), "5");
  });

  test("adapterCandidatesQueryUrl rejects invalid operational_kinds", () => {
    assert.throws(
      () => adapterCandidatesQueryUrl({ operational_kinds: "bogus" }),
      ((err: Row) => err.code === "invalid_params") as AnyFn,
    );
  });

  test("adapterCandidatesQueryUrl rejects invalid recommended_adapter_kind", () => {
    assert.throws(
      () => adapterCandidatesQueryUrl({ recommended_adapter_kind: "bogus" }),
      ((err: Row) => err.code === "invalid_params") as AnyFn,
    );
  });

  test("adapterCandidatesQueryUrl rejects invalid netuid", () => {
    assert.throws(
      () => adapterCandidatesQueryUrl({ netuid: -1 }),
      ((err: Row) => err.code === "invalid_params") as AnyFn,
    );
  });

  test("adapterCandidatesQueryUrl rejects invalid sort", () => {
    assert.throws(
      () => adapterCandidatesQueryUrl({ sort: "not_a_column" }),
      ((err: Row) => err.code === "invalid_params") as AnyFn,
    );
  });

  test("adapterCandidatesQueryUrl rejects non-string fields and invalid order", () => {
    assert.throws(
      () => adapterCandidatesQueryUrl({ fields: 42 }),
      ((err: Row) => err.code === "invalid_params") as AnyFn,
    );
    assert.throws(
      () => adapterCandidatesQueryUrl({ order: "sideways" }),
      ((err: Row) => err.code === "invalid_params") as AnyFn,
    );
  });

  test("adapterCandidatesQueryUrl rejects empty fields projection", () => {
    assert.throws(
      () => adapterCandidatesQueryUrl({ fields: "   " }),
      ((err: Row) => err.code === "invalid_params") as AnyFn,
    );
  });

  test("adapterCandidatesQueryUrl trims and forwards a fields projection", () => {
    const url = adapterCandidatesQueryUrl({
      fields: " netuid,priority_score ",
    });
    assert.equal(url.searchParams.get("fields"), "netuid,priority_score");
  });

  test("adapterCandidatesQueryUrl clamps a non-numeric limit to the default", () => {
    const url = adapterCandidatesQueryUrl({ limit: "lots" });
    assert.equal(url.searchParams.get("limit"), "50");
  });

  test("adapterCandidatesQueryUrl clamps a sub-minimum numeric limit to the default", () => {
    const url = adapterCandidatesQueryUrl({ limit: 0 });
    assert.equal(url.searchParams.get("limit"), "50");
  });

  test("adapterCandidatesQueryUrl rejects a fractional netuid", () => {
    assert.throws(
      () => adapterCandidatesQueryUrl({ netuid: 1.5 }),
      ((err: Row) => err.code === "invalid_params") as AnyFn,
    );
  });

  test("adapterCandidatesQueryUrl rejects a fractional cursor", () => {
    assert.throws(
      () => adapterCandidatesQueryUrl({ cursor: 1.5 }),
      ((err: Row) => err.code === "invalid_params") as AnyFn,
    );
  });

  test("adapterCandidatesQueryUrl rejects negative cursor", () => {
    assert.throws(
      () => adapterCandidatesQueryUrl({ cursor: -1 }),
      ((err: Row) => err.code === "invalid_params") as AnyFn,
    );
  });

  test("adapterCandidatesQueryUrl clamps limit above the MCP maximum", () => {
    const url = adapterCandidatesQueryUrl({ limit: 500 });
    assert.equal(url.searchParams.get("limit"), "100");
  });

  test("loadAdapterCandidatesList returns filtered rows with pagination meta", async () => {
    const out = await loadAdapterCandidatesList(
      { env: mockEnv(), readArtifact },
      { operational_kinds: "openapi" },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.candidates[0].netuid, 7);
    assert.equal(out.candidates[0].priority_score, 88);
  });

  test("loadAdapterCandidatesList sorts and pages the collection", async () => {
    const out = await loadAdapterCandidatesList(
      { env: mockEnv(), readArtifact },
      { sort: "priority_score", order: "desc", limit: 1 },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.total, 2);
    assert.equal(out.candidates[0].netuid, 7);
    assert.equal(out.next_cursor, 1);
  });

  test("loadAdapterCandidatesList uses an injected readArtifact dep", async () => {
    const out = await loadAdapterCandidatesList(
      {
        env: mockEnv(),
        readArtifact: (async () => ({
          ok: false,
        })) as unknown as ReadArtifact,
      },
      {},
      {
        readArtifact: (async () => ({
          ok: true,
          data: {
            candidates: [
              { netuid: 0, recommended_adapter_kind: "custom-adapter" },
            ],
          },
        })) as unknown as ReadArtifact,
      },
    );
    assert.equal(out.candidates[0].netuid, 0);
  });

  test("loadAdapterCandidatesList maps artifact_not_found to not_found", async () => {
    await assert.rejects(
      () =>
        loadAdapterCandidatesList(
          {
            env: mockEnv(),
            readArtifact: (async () => ({
              ok: false,
              code: "artifact_not_found",
            })) as unknown as ReadArtifact,
          },
          {},
        ),
      ((err: Row) => err.code === "not_found") as AnyFn,
    );
  });

  test("loadAdapterCandidatesList surfaces other artifact failures", async () => {
    await assert.rejects(
      () =>
        loadAdapterCandidatesList(
          {
            env: mockEnv(),
            readArtifact: (async () => ({
              ok: false,
              code: "artifact_timeout",
            })) as unknown as ReadArtifact,
          },
          {},
        ),
      ((err: Row) =>
        err.code === "artifact_timeout" &&
        /adapter-candidates\.json/.test(err.message)) as AnyFn,
    );
  });

  test("loadAdapterCandidatesList rejects invalid list-query params from REST parity", async () => {
    await assert.rejects(
      () =>
        loadAdapterCandidatesList(
          { env: mockEnv(), readArtifact },
          { fields: "not_a_column" },
        ),
      ((err: Row) => err.code === "invalid_params") as AnyFn,
    );
  });

  test("loadAdapterCandidatesList projects row fields when requested", async () => {
    const out = await loadAdapterCandidatesList(
      { env: mockEnv(), readArtifact },
      { fields: "netuid,priority_score", limit: 1 },
    );
    assert.deepEqual(out.candidates[0], { netuid: 7, priority_score: 88 });
  });

  test("loadAdapterCandidatesList omits nullable artifact metadata when absent", async () => {
    const out = await loadAdapterCandidatesList(
      {
        env: mockEnv(),
        readArtifact: (async () => ({
          ok: true,
          data: { candidates: [{ netuid: 0, priority_score: 1 }] },
        })) as unknown as ReadArtifact,
      },
      {},
    );
    assert.equal(out.generated_at, null);
    assert.equal(out.notes, null);
  });

  test("loadAdapterCandidatesList treats a non-array candidates key as empty", async () => {
    const out = await loadAdapterCandidatesList(
      {
        env: mockEnv(),
        readArtifact: (async () => ({
          ok: true,
          data: { candidates: null },
        })) as unknown as ReadArtifact,
      },
      {},
    );
    assert.deepEqual(out.candidates, []);
    assert.equal(out.total, 0);
  });

  test("loadAdapterCandidatesList falls back when pagination meta is absent", async () => {
    const spy = vi.spyOn(listQuery, "applyQueryFilters").mockReturnValue({
      data: { candidates: [{ netuid: 9 }, { netuid: 10 }] },
      meta: {},
    });
    try {
      const out = await loadAdapterCandidatesList(
        { env: mockEnv(), readArtifact },
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

  test("loadAdapterCandidatesList rejects a malformed artifact payload", async () => {
    await assert.rejects(
      () =>
        loadAdapterCandidatesList(
          {
            env: mockEnv(),
            readArtifact: (async () => ({
              ok: true,
              data: null,
            })) as unknown as ReadArtifact,
          },
          {},
        ),
      ((err: Row) => err.code === "not_found") as AnyFn,
    );
  });

  test("loadAdapterCandidatesList defaults code when the read result is bare", async () => {
    await assert.rejects(
      () =>
        loadAdapterCandidatesList(
          {
            env: mockEnv(),
            readArtifact: (async () => ({
              ok: false,
            })) as unknown as ReadArtifact,
          },
          {},
        ),
      ((err: Row) => err.code === "artifact_unavailable") as AnyFn,
    );
  });

  test("MCP tool metadata and outputSchema compile", () => {
    assert.equal(
      LIST_ADAPTER_CANDIDATES_MCP_TOOL.name,
      "list_adapter_candidates",
    );
    assert.match(
      LIST_ADAPTER_CANDIDATES_INSTRUCTIONS,
      /list_adapter_candidates/,
    );
    assert.ok(
      new Ajv2020({ strict: false }).compile(
        LIST_ADAPTER_CANDIDATES_OUTPUT_SCHEMA,
      ),
    );
  });

  test("MCP server exports wire list_adapter_candidates", () => {
    assert.match(MCP_INSTRUCTIONS, /list_adapter_candidates/);
    const tool = MCP_TOOLS.find((t) => t.name === "list_adapter_candidates");
    assert.ok(tool);
    assert.equal(tool.title, "List review adapter candidates");
  });
});
