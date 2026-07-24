import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import * as listQuery from "../workers/list-query.ts";
import {
  LIST_SUBNET_CANDIDATES_INSTRUCTIONS,
  LIST_SUBNET_CANDIDATES_MCP_TOOL,
  LIST_SUBNET_CANDIDATES_OUTPUT_SCHEMA,
  loadSubnetCandidatesList,
  subnetCandidatesArtifactPath,
  subnetCandidatesMcpError,
  subnetCandidatesQueryUrl,
} from "../src/subnet-candidates-mcp.ts";
import type { Row } from "./row-type.ts";

type LoadCtx = Parameters<typeof loadSubnetCandidatesList>[0];
type LoadDeps = Parameters<typeof loadSubnetCandidatesList>[2];

import { MCP_INSTRUCTIONS, MCP_TOOLS } from "../src/mcp-server.ts";

const NETUID = 7;
const ARTIFACT = subnetCandidatesArtifactPath(NETUID);

const SAMPLE_BLOB = {
  generated_at: "2026-07-01T00:00:00.000Z",
  netuid: NETUID,
  candidates: [
    {
      id: "allways-api",
      netuid: NETUID,
      kind: "subnet-api",
      provider: "allways",
      state: "maintainer-review",
      confidence: "high",
    },
    {
      id: "allways-openapi",
      netuid: NETUID,
      kind: "openapi",
      provider: "allways",
      state: "schema-valid",
      confidence: "low",
    },
    {
      id: "beta-api",
      netuid: NETUID,
      kind: "subnet-api",
      provider: "beta",
      state: "schema-valid",
      confidence: "low",
    },
  ],
};

function readArtifact(_env: unknown, path: string) {
  if (path === ARTIFACT) {
    return Promise.resolve({ ok: true, data: SAMPLE_BLOB });
  }
  return Promise.resolve({ ok: false, code: "artifact_not_found" });
}

describe("subnet-candidates-mcp", () => {
  test("subnetCandidatesMcpError is shaped for MCP toolError handling", () => {
    const err = subnetCandidatesMcpError("invalid_params", "bad kind");
    assert.equal(err.code, "invalid_params");
    assert.equal(err.toolError, true);
  });

  test("subnetCandidatesQueryUrl validates filters and cursor", () => {
    const url = subnetCandidatesQueryUrl({
      netuid: NETUID,
      kind: "subnet-api",
      provider: "allways",
      state: "maintainer-review",
      id: "allways-api",
      confidence: "high",
      sort: "confidence",
      order: "desc",
      fields: "id,kind",
      limit: 10,
      cursor: 5,
    });
    assert.equal(url.searchParams.get("kind"), "subnet-api");
    assert.equal(url.searchParams.get("provider"), "allways");
    assert.equal(url.searchParams.get("state"), "maintainer-review");
    assert.equal(url.searchParams.get("id"), "allways-api");
    assert.equal(url.searchParams.get("confidence"), "high");
    assert.equal(url.searchParams.get("sort"), "confidence");
    assert.equal(url.searchParams.get("order"), "desc");
    assert.equal(url.searchParams.get("limit"), "10");
    assert.equal(url.searchParams.get("cursor"), "5");
  });

  test("subnetCandidatesQueryUrl rejects missing netuid", () => {
    assert.throws(
      () => subnetCandidatesQueryUrl({}),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("subnetCandidatesQueryUrl rejects invalid kind", () => {
    assert.throws(
      () => subnetCandidatesQueryUrl({ netuid: NETUID, kind: "bogus" }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("subnetCandidatesQueryUrl rejects invalid state", () => {
    assert.throws(
      () => subnetCandidatesQueryUrl({ netuid: NETUID, state: "bogus" }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("subnetCandidatesQueryUrl rejects invalid confidence", () => {
    assert.throws(
      () => subnetCandidatesQueryUrl({ netuid: NETUID, confidence: "extreme" }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("subnetCandidatesQueryUrl rejects empty provider and invalid sort", () => {
    assert.throws(
      () => subnetCandidatesQueryUrl({ netuid: NETUID, provider: "   " }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => subnetCandidatesQueryUrl({ netuid: NETUID, sort: "not_a_column" }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("subnetCandidatesQueryUrl rejects non-string id and invalid order", () => {
    assert.throws(
      () => subnetCandidatesQueryUrl({ netuid: NETUID, id: 42 }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => subnetCandidatesQueryUrl({ netuid: NETUID, order: "sideways" }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("subnetCandidatesQueryUrl rejects empty fields and non-string fields", () => {
    assert.throws(
      () => subnetCandidatesQueryUrl({ netuid: NETUID, fields: "   " }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => subnetCandidatesQueryUrl({ netuid: NETUID, fields: 42 }),
      (err: Row) => err.code === "invalid_params",
    );
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
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("subnetCandidatesQueryUrl rejects a fractional cursor", () => {
    assert.throws(
      () => subnetCandidatesQueryUrl({ netuid: NETUID, cursor: 1.5 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("subnetCandidatesQueryUrl rejects negative cursor", () => {
    assert.throws(
      () => subnetCandidatesQueryUrl({ netuid: NETUID, cursor: -1 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("subnetCandidatesQueryUrl clamps limit above the MCP maximum", () => {
    const url = subnetCandidatesQueryUrl({ netuid: NETUID, limit: 500 });
    assert.equal(url.searchParams.get("limit"), "100");
  });

  // The deliverable the issue names: at least two filters combined plus
  // pagination, over the REST-parity list query.
  test("loadSubnetCandidatesList combines two filters (kind + state)", async () => {
    const out = await loadSubnetCandidatesList(
      { env: {}, readArtifact } as unknown as LoadCtx,
      { netuid: NETUID, kind: "subnet-api", state: "schema-valid" },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.candidates[0].id, "beta-api");
    assert.equal(out.candidates[0].kind, "subnet-api");
    assert.equal(out.candidates[0].state, "schema-valid");
    assert.equal(out.netuid, NETUID);
  });

  test("loadSubnetCandidatesList filters by confidence then sorts and pages", async () => {
    const out = await loadSubnetCandidatesList(
      { env: {}, readArtifact } as unknown as LoadCtx,
      {
        netuid: NETUID,
        confidence: "low",
        sort: "id",
        order: "asc",
        limit: 1,
      },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.total, 2);
    assert.equal(out.candidates[0].id, "allways-openapi");
    assert.equal(out.next_cursor, 1);
  });

  test("loadSubnetCandidatesList follows the next_cursor to the second page", async () => {
    const out = await loadSubnetCandidatesList(
      { env: {}, readArtifact } as unknown as LoadCtx,
      {
        netuid: NETUID,
        confidence: "low",
        sort: "id",
        order: "asc",
        limit: 1,
        cursor: 1,
      },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.candidates[0].id, "beta-api");
    assert.equal(out.next_cursor, null);
  });

  test("loadSubnetCandidatesList uses an injected readArtifact dep", async () => {
    const out = await loadSubnetCandidatesList(
      {
        env: {},
        readArtifact: async () => ({ ok: false }),
      } as unknown as LoadCtx,
      { netuid: 0 },
      {
        readArtifact: async () => ({
          ok: true,
          data: {
            candidates: [{ netuid: 0, kind: "docs" }],
          },
        }),
      } as unknown as LoadDeps,
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
          } as unknown as LoadCtx,
          { netuid: NETUID },
        ),
      (err: Row) => err.code === "not_found",
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
          } as unknown as LoadCtx,
          { netuid: NETUID },
        ),
      (err: Row) =>
        err.code === "artifact_timeout" &&
        /candidates\/7\.json/.test(err.message),
    );
  });

  test("loadSubnetCandidatesList rejects invalid list-query params from REST parity", async () => {
    await assert.rejects(
      () =>
        loadSubnetCandidatesList(
          { env: {}, readArtifact } as unknown as LoadCtx,
          { netuid: NETUID, fields: "not_a_column" },
        ),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("loadSubnetCandidatesList projects row fields when requested", async () => {
    const out = await loadSubnetCandidatesList(
      { env: {}, readArtifact } as unknown as LoadCtx,
      { netuid: NETUID, fields: "id,kind", limit: 1 },
    );
    assert.deepEqual(out.candidates[0], {
      id: "allways-api",
      kind: "subnet-api",
    });
  });

  test("loadSubnetCandidatesList omits nullable artifact metadata when absent", async () => {
    const out = await loadSubnetCandidatesList(
      {
        env: {},
        readArtifact: async () => ({
          ok: true,
          data: { candidates: [{ netuid: 0, kind: "docs" }] },
        }),
      } as unknown as LoadCtx,
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
      } as unknown as LoadCtx,
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
        { env: {}, readArtifact } as unknown as LoadCtx,
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
          } as unknown as LoadCtx,
          { netuid: NETUID },
        ),
      (err: Row) => err.code === "not_found",
    );
  });

  test("loadSubnetCandidatesList defaults code when the read result is bare", async () => {
    await assert.rejects(
      () =>
        loadSubnetCandidatesList(
          {
            env: {},
            readArtifact: async () => ({ ok: false }),
          } as unknown as LoadCtx,
          { netuid: NETUID },
        ),
      (err: Row) => err.code === "artifact_unavailable",
    );
  });

  test("loadSubnetCandidatesList rejects missing netuid", async () => {
    await assert.rejects(
      () =>
        loadSubnetCandidatesList(
          { env: {}, readArtifact } as unknown as LoadCtx,
          {},
        ),
      (err: Row) => err.code === "invalid_params",
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

  test("MCP server exports wire list_subnet_candidates", () => {
    assert.match(MCP_INSTRUCTIONS, /list_subnet_candidates/);
    const tool = MCP_TOOLS.find(
      (t: Row) => t.name === "list_subnet_candidates",
    );
    assert.ok(tool);
    assert.equal(tool.title, "List one subnet's candidate surfaces");
  });

  test("the registered tool handler delegates to loadSubnetCandidatesList", async () => {
    const tool = MCP_TOOLS.find(
      (t: Row) => t.name === "list_subnet_candidates",
    );
    assert.ok(tool);
    const out = await tool.handler(
      { netuid: NETUID, kind: "subnet-api", state: "schema-valid" },
      { env: {}, readArtifact } as unknown as LoadCtx,
    );
    assert.equal(out.returned, 1);
    assert.equal(out.candidates[0].id, "beta-api");
  });
});
