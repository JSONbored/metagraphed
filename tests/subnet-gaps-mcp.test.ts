import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import * as listQuery from "../workers/list-query.ts";
import {
  LIST_SUBNET_GAPS_INSTRUCTIONS,
  LIST_SUBNET_GAPS_MCP_TOOL,
  LIST_SUBNET_GAPS_OUTPUT_SCHEMA,
  loadSubnetGapsList,
  subnetGapsArtifactPath,
  subnetGapsMcpError,
  subnetGapsQueryUrl,
} from "../src/subnet-gaps-mcp.ts";
import type { Row } from "./row-type.ts";

type LoadCtx = Parameters<typeof loadSubnetGapsList>[0];
type LoadDeps = Parameters<typeof loadSubnetGapsList>[2];

import { MCP_INSTRUCTIONS, MCP_TOOLS } from "../src/mcp-server.ts";

const NETUID = 7;
const ARTIFACT = subnetGapsArtifactPath(NETUID);

const SAMPLE_BLOB = {
  generated_at: "2026-07-01T00:00:00.000Z",
  netuid: NETUID,
  priorities: [
    {
      netuid: NETUID,
      name: "alpha",
      curation_level: "native",
      missing_kinds: "openapi",
      review_state: "pending",
      priority_score: 90,
    },
    {
      netuid: NETUID,
      name: "beta",
      curation_level: "community-seeded",
      missing_kinds: "openapi",
      review_state: "pending",
      priority_score: 50,
    },
    {
      netuid: NETUID,
      name: "gamma",
      curation_level: "community-seeded",
      missing_kinds: "docs",
      review_state: "done",
      priority_score: 10,
    },
  ],
};

function readArtifact(_env: unknown, path: string) {
  if (path === ARTIFACT) {
    return Promise.resolve({ ok: true, data: SAMPLE_BLOB });
  }
  return Promise.resolve({ ok: false, code: "artifact_not_found" });
}

describe("subnet-gaps-mcp", () => {
  test("subnetGapsMcpError is shaped for MCP toolError handling", () => {
    const err = subnetGapsMcpError("invalid_params", "bad curation_level");
    assert.equal(err.code, "invalid_params");
    assert.equal(err.toolError, true);
  });

  test("subnetGapsQueryUrl validates filters and cursor", () => {
    const url = subnetGapsQueryUrl({
      netuid: NETUID,
      curation_level: "native",
      missing_kinds: "openapi",
      review_state: "pending",
      sort: "priority_score",
      order: "desc",
      fields: "name,priority_score",
      limit: 10,
      cursor: 5,
    });
    assert.equal(url.searchParams.get("curation_level"), "native");
    assert.equal(url.searchParams.get("missing_kinds"), "openapi");
    assert.equal(url.searchParams.get("review_state"), "pending");
    assert.equal(url.searchParams.get("sort"), "priority_score");
    assert.equal(url.searchParams.get("order"), "desc");
    assert.equal(url.searchParams.get("limit"), "10");
    assert.equal(url.searchParams.get("cursor"), "5");
  });

  test("subnetGapsQueryUrl rejects missing netuid", () => {
    assert.throws(
      () => subnetGapsQueryUrl({}),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("subnetGapsQueryUrl rejects invalid curation_level", () => {
    assert.throws(
      () => subnetGapsQueryUrl({ netuid: NETUID, curation_level: "bogus" }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("subnetGapsQueryUrl rejects invalid missing_kinds", () => {
    assert.throws(
      () => subnetGapsQueryUrl({ netuid: NETUID, missing_kinds: "bogus" }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("subnetGapsQueryUrl rejects empty review_state and invalid sort", () => {
    assert.throws(
      () => subnetGapsQueryUrl({ netuid: NETUID, review_state: "   " }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => subnetGapsQueryUrl({ netuid: NETUID, sort: "not_a_column" }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("subnetGapsQueryUrl rejects non-string review_state and invalid order", () => {
    assert.throws(
      () => subnetGapsQueryUrl({ netuid: NETUID, review_state: 42 }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => subnetGapsQueryUrl({ netuid: NETUID, order: "sideways" }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("subnetGapsQueryUrl rejects empty fields and non-string fields", () => {
    assert.throws(
      () => subnetGapsQueryUrl({ netuid: NETUID, fields: "   " }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => subnetGapsQueryUrl({ netuid: NETUID, fields: 42 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("subnetGapsQueryUrl clamps a non-numeric limit to the default", () => {
    const url = subnetGapsQueryUrl({ netuid: NETUID, limit: "lots" });
    assert.equal(url.searchParams.get("limit"), "50");
  });

  test("subnetGapsQueryUrl clamps a sub-minimum numeric limit to the default", () => {
    const url = subnetGapsQueryUrl({ netuid: NETUID, limit: 0 });
    assert.equal(url.searchParams.get("limit"), "50");
  });

  test("subnetGapsQueryUrl clamps limit above the MCP maximum", () => {
    const url = subnetGapsQueryUrl({ netuid: NETUID, limit: 500 });
    assert.equal(url.searchParams.get("limit"), "100");
  });

  test("subnetGapsQueryUrl rejects a fractional netuid", () => {
    assert.throws(
      () => subnetGapsQueryUrl({ netuid: 1.5 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("subnetGapsQueryUrl rejects a fractional cursor", () => {
    assert.throws(
      () => subnetGapsQueryUrl({ netuid: NETUID, cursor: 1.5 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("subnetGapsQueryUrl rejects negative cursor", () => {
    assert.throws(
      () => subnetGapsQueryUrl({ netuid: NETUID, cursor: -1 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  // The deliverables the issue names: a curation_level filter and a
  // missing_kinds filter.
  test("loadSubnetGapsList filters by curation_level", async () => {
    const out = await loadSubnetGapsList(
      { env: {}, readArtifact } as unknown as LoadCtx,
      { netuid: NETUID, curation_level: "native" },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.priorities[0].name, "alpha");
    assert.equal(out.netuid, NETUID);
  });

  test("loadSubnetGapsList filters by missing_kinds", async () => {
    const out = await loadSubnetGapsList(
      { env: {}, readArtifact } as unknown as LoadCtx,
      { netuid: NETUID, missing_kinds: "openapi" },
    );
    assert.equal(out.returned, 2);
    assert.deepEqual(
      out.priorities.map((row: Row) => row.name),
      ["alpha", "beta"],
    );
  });

  test("loadSubnetGapsList combines both filters, then sorts and pages", async () => {
    const out = await loadSubnetGapsList(
      { env: {}, readArtifact } as unknown as LoadCtx,
      {
        netuid: NETUID,
        curation_level: "community-seeded",
        missing_kinds: "openapi",
        sort: "priority_score",
        order: "desc",
        limit: 1,
      },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.total, 1);
    assert.equal(out.priorities[0].name, "beta");
    assert.equal(out.next_cursor, null);
  });

  test("loadSubnetGapsList pages through to next_cursor and back", async () => {
    const first = await loadSubnetGapsList(
      { env: {}, readArtifact } as unknown as LoadCtx,
      { netuid: NETUID, missing_kinds: "openapi", sort: "name", limit: 1 },
    );
    assert.equal(first.priorities[0].name, "alpha");
    assert.equal(first.next_cursor, 1);
    const second = await loadSubnetGapsList(
      { env: {}, readArtifact } as unknown as LoadCtx,
      {
        netuid: NETUID,
        missing_kinds: "openapi",
        sort: "name",
        limit: 1,
        cursor: 1,
      },
    );
    assert.equal(second.priorities[0].name, "beta");
    assert.equal(second.next_cursor, null);
  });

  test("loadSubnetGapsList uses an injected readArtifact dep", async () => {
    const out = await loadSubnetGapsList(
      {
        env: {},
        readArtifact: async () => ({ ok: false }),
      } as unknown as LoadCtx,
      { netuid: 0 },
      {
        readArtifact: async () => ({
          ok: true,
          data: { priorities: [{ netuid: 0, name: "solo" }] },
        }),
      } as unknown as LoadDeps,
    );
    assert.equal(out.priorities[0].netuid, 0);
  });

  test("loadSubnetGapsList maps artifact_not_found to not_found", async () => {
    await assert.rejects(
      () =>
        loadSubnetGapsList(
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

  test("loadSubnetGapsList surfaces other artifact failures", async () => {
    await assert.rejects(
      () =>
        loadSubnetGapsList(
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
        err.code === "artifact_timeout" && /gaps\/7\.json/.test(err.message),
    );
  });

  test("loadSubnetGapsList rejects invalid list-query params from REST parity", async () => {
    await assert.rejects(
      () =>
        loadSubnetGapsList({ env: {}, readArtifact } as unknown as LoadCtx, {
          netuid: NETUID,
          fields: "not_a_column",
        }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("loadSubnetGapsList projects row fields when requested", async () => {
    const out = await loadSubnetGapsList(
      { env: {}, readArtifact } as unknown as LoadCtx,
      { netuid: NETUID, fields: "name,priority_score", limit: 1 },
    );
    assert.deepEqual(out.priorities[0], {
      name: "alpha",
      priority_score: 90,
    });
  });

  test("loadSubnetGapsList omits nullable artifact metadata when absent", async () => {
    const out = await loadSubnetGapsList(
      {
        env: {},
        readArtifact: async () => ({
          ok: true,
          data: { priorities: [{ netuid: 0, name: "solo" }] },
        }),
      } as unknown as LoadCtx,
      { netuid: 0 },
    );
    assert.equal(out.generated_at, null);
  });

  test("loadSubnetGapsList treats a non-array priorities key as empty", async () => {
    const out = await loadSubnetGapsList(
      {
        env: {},
        readArtifact: async () => ({ ok: true, data: { priorities: null } }),
      } as unknown as LoadCtx,
      { netuid: NETUID },
    );
    assert.deepEqual(out.priorities, []);
    assert.equal(out.total, 0);
  });

  test("loadSubnetGapsList falls back when pagination meta is absent", async () => {
    const spy = vi.spyOn(listQuery, "applyQueryFilters").mockReturnValue({
      data: { priorities: [{ netuid: 9 }, { netuid: 9 }] },
      meta: {},
    });
    try {
      const out = await loadSubnetGapsList(
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

  test("loadSubnetGapsList rejects a malformed artifact payload", async () => {
    await assert.rejects(
      () =>
        loadSubnetGapsList(
          {
            env: {},
            readArtifact: async () => ({ ok: true, data: null }),
          } as unknown as LoadCtx,
          { netuid: NETUID },
        ),
      (err: Row) => err.code === "not_found",
    );
  });

  test("loadSubnetGapsList defaults code when the read result is bare", async () => {
    await assert.rejects(
      () =>
        loadSubnetGapsList(
          {
            env: {},
            readArtifact: async () => ({ ok: false }),
          } as unknown as LoadCtx,
          { netuid: NETUID },
        ),
      (err: Row) => err.code === "artifact_unavailable",
    );
  });

  test("loadSubnetGapsList rejects missing netuid", async () => {
    await assert.rejects(
      () =>
        loadSubnetGapsList({ env: {}, readArtifact } as unknown as LoadCtx, {}),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("MCP tool metadata and outputSchema compile", () => {
    assert.equal(LIST_SUBNET_GAPS_MCP_TOOL.name, "list_subnet_gaps");
    assert.match(LIST_SUBNET_GAPS_INSTRUCTIONS, /list_subnet_gaps/);
    assert.ok(
      new Ajv2020({ strict: false }).compile(LIST_SUBNET_GAPS_OUTPUT_SCHEMA),
    );
  });

  test("MCP server exports wire list_subnet_gaps", () => {
    assert.match(MCP_INSTRUCTIONS, /list_subnet_gaps/);
    const tool = MCP_TOOLS.find((t: Row) => t.name === "list_subnet_gaps");
    assert.ok(tool);
    assert.equal(tool.title, "List one subnet's interface gap priorities");
  });

  test("the registered tool handler delegates to loadSubnetGapsList", async () => {
    const tool = MCP_TOOLS.find((t: Row) => t.name === "list_subnet_gaps");
    assert.ok(tool);
    const out = await tool.handler(
      { netuid: NETUID, curation_level: "native" },
      { env: {}, readArtifact } as unknown as LoadCtx,
    );
    assert.equal(out.returned, 1);
    assert.equal(out.priorities[0].name, "alpha");
  });
});
