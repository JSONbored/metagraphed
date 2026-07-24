import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import * as listQuery from "../workers/list-query.ts";
import {
  LIST_PROVIDERS_INSTRUCTIONS,
  LIST_PROVIDERS_MCP_TOOL,
  LIST_PROVIDERS_OUTPUT_SCHEMA,
  PROVIDERS_ARTIFACT,
  loadProvidersList,
  providersMcpError,
  providersQueryUrl,
} from "../src/providers-mcp.ts";
import type { Row } from "./row-type.ts";

type LoadCtx = Parameters<typeof loadProvidersList>[0];
type LoadDeps = Parameters<typeof loadProvidersList>[2];

import { MCP_INSTRUCTIONS, MCP_TOOLS } from "../src/mcp-server.ts";

const SAMPLE_BLOB = {
  generated_at: "2026-07-01T00:00:00.000Z",
  schema_version: 1,
  providers: [
    {
      id: "datura",
      kind: "data-provider",
      authority: "official",
      name: "Datura",
    },
    {
      id: "chutes",
      kind: "infrastructure-provider",
      authority: "official",
      name: "Chutes",
    },
    {
      id: "community-x",
      kind: "data-provider",
      authority: "community",
      name: "Community X",
    },
  ],
};

function readArtifact(_env: unknown, path: string) {
  if (path === PROVIDERS_ARTIFACT) {
    return Promise.resolve({ ok: true, data: SAMPLE_BLOB });
  }
  return Promise.resolve({ ok: false, code: "artifact_not_found" });
}

describe("providers-mcp", () => {
  test("providersMcpError is shaped for MCP toolError handling", () => {
    const err = providersMcpError("invalid_params", "bad kind");
    assert.equal(err.code, "invalid_params");
    assert.equal(err.toolError, true);
  });

  test("providersQueryUrl validates filters and cursor", () => {
    const url = providersQueryUrl({
      id: "datura",
      kind: "data-provider",
      authority: "official",
      sort: "name",
      order: "asc",
      fields: "id,name",
      limit: 10,
      cursor: 5,
    });
    assert.equal(url.searchParams.get("id"), "datura");
    assert.equal(url.searchParams.get("kind"), "data-provider");
    assert.equal(url.searchParams.get("authority"), "official");
    assert.equal(url.searchParams.get("sort"), "name");
    assert.equal(url.searchParams.get("limit"), "10");
    assert.equal(url.searchParams.get("cursor"), "5");
  });

  test("providersQueryUrl rejects empty id and invalid kind", () => {
    assert.throws(
      () => providersQueryUrl({ id: "   " }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => providersQueryUrl({ kind: "not-a-kind" }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("providersQueryUrl rejects invalid authority and sort", () => {
    assert.throws(
      () => providersQueryUrl({ authority: "not-an-authority" }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => providersQueryUrl({ sort: "not_a_column" }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("providersQueryUrl rejects non-string id and invalid order", () => {
    assert.throws(
      () => providersQueryUrl({ id: 42 }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => providersQueryUrl({ order: "sideways" }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("providersQueryUrl rejects empty fields and non-string fields", () => {
    assert.throws(
      () => providersQueryUrl({ fields: "   " }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => providersQueryUrl({ fields: 42 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("providersQueryUrl trims and forwards a fields projection", () => {
    const url = providersQueryUrl({ fields: " id,name " });
    assert.equal(url.searchParams.get("fields"), "id,name");
  });

  test("providersQueryUrl rejects a non-numeric limit", () => {
    assert.throws(
      () => providersQueryUrl({ limit: "lots" }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("providersQueryUrl rejects a sub-minimum limit", () => {
    assert.throws(
      () => providersQueryUrl({ limit: 0 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("providersQueryUrl rejects a fractional cursor", () => {
    assert.throws(
      () => providersQueryUrl({ cursor: 1.5 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("providersQueryUrl rejects negative cursor", () => {
    assert.throws(
      () => providersQueryUrl({ cursor: -1 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("providersQueryUrl rejects a limit above the MCP maximum", () => {
    assert.throws(
      () => providersQueryUrl({ limit: 500 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("loadProvidersList returns filtered rows with pagination meta", async () => {
    const out = await loadProvidersList(
      { env: {}, readArtifact } as unknown as LoadCtx,
      { id: "chutes" },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.providers[0].name, "Chutes");
  });

  test("loadProvidersList sorts and pages the collection", async () => {
    const out = await loadProvidersList(
      { env: {}, readArtifact } as unknown as LoadCtx,
      { sort: "name", order: "desc", limit: 1 },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.total, 3);
    assert.equal(out.next_cursor, 1);
  });

  test("loadProvidersList combines filters with AND semantics", async () => {
    const out = await loadProvidersList(
      { env: {}, readArtifact } as unknown as LoadCtx,
      { kind: "data-provider", authority: "community" },
    );
    assert.equal(out.returned, 1);
    assert.equal(out.providers[0].id, "community-x");
  });

  test("loadProvidersList uses an injected readArtifact dep", async () => {
    const out = await loadProvidersList(
      {
        env: {},
        readArtifact: async () => ({ ok: false }),
      } as unknown as LoadCtx,
      {},
      {
        readArtifact: async () => ({
          ok: true,
          data: { providers: [{ id: "solo", name: "Solo" }] },
        }),
      } as unknown as LoadDeps,
    );
    assert.equal(out.providers[0].id, "solo");
  });

  test("loadProvidersList maps artifact_not_found to not_found", async () => {
    await assert.rejects(
      () =>
        loadProvidersList(
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

  test("loadProvidersList surfaces other artifact failures", async () => {
    await assert.rejects(
      () =>
        loadProvidersList(
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
        err.code === "artifact_timeout" && /providers\.json/.test(err.message),
    );
  });

  test("loadProvidersList rejects invalid list-query params from REST parity", async () => {
    await assert.rejects(
      () =>
        loadProvidersList({ env: {}, readArtifact } as unknown as LoadCtx, {
          fields: "not_a_column",
        }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("loadProvidersList projects row fields when requested", async () => {
    const out = await loadProvidersList(
      { env: {}, readArtifact } as unknown as LoadCtx,
      { id: "datura", fields: "id,name" },
    );
    assert.deepEqual(out.providers[0], {
      id: "datura",
      name: "Datura",
    });
  });

  test("loadProvidersList omits nullable artifact metadata when absent", async () => {
    const out = await loadProvidersList(
      {
        env: {},
        readArtifact: async () => ({
          ok: true,
          data: { providers: [{ id: "solo" }] },
        }),
      } as unknown as LoadCtx,
      {},
    );
    assert.equal(out.generated_at, null);
    assert.equal(out.schema_version, null);
  });

  test("loadProvidersList treats a non-array providers key as empty", async () => {
    const out = await loadProvidersList(
      {
        env: {},
        readArtifact: async () => ({
          ok: true,
          data: { providers: null },
        }),
      } as unknown as LoadCtx,
      {},
    );
    assert.deepEqual(out.providers, []);
    assert.equal(out.total, 0);
  });

  test("loadProvidersList falls back when pagination meta is absent", async () => {
    const spy = vi.spyOn(listQuery, "applyQueryFilters").mockReturnValue({
      data: { providers: [{ id: "a" }, { id: "b" }] },
      meta: {},
    });
    try {
      const out = await loadProvidersList(
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

  test("loadProvidersList rejects a malformed artifact payload", async () => {
    await assert.rejects(
      () =>
        loadProvidersList(
          {
            env: {},
            readArtifact: async () => ({ ok: true, data: null }),
          } as unknown as LoadCtx,
          {},
        ),
      (err: Row) => err.code === "not_found",
    );
  });

  test("loadProvidersList defaults code when the read result is bare", async () => {
    await assert.rejects(
      () =>
        loadProvidersList(
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
    assert.equal(LIST_PROVIDERS_MCP_TOOL.name, "list_providers");
    assert.match(LIST_PROVIDERS_INSTRUCTIONS, /list_providers/);
    assert.ok(
      new Ajv2020({ strict: false }).compile(LIST_PROVIDERS_OUTPUT_SCHEMA),
    );
  });

  test("MCP server exports wire list_providers", () => {
    assert.match(MCP_INSTRUCTIONS, /list_providers/);
    const tool = MCP_TOOLS.find((t: Row) => t.name === "list_providers");
    assert.ok(tool);
    assert.equal(tool.title, "List providers and sources");
  });
});
