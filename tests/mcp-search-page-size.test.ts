import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import { handleMcpRequest, listToolDefinitions } from "../src/mcp-server.ts";
import {
  searchToolDefinitions,
  searchToolsPageSizeForUrl,
  type SearchToolsPageSize,
} from "../src/mcp-tool-discovery.ts";
import { resetModuleState } from "../src/module-state-registry.ts";
import { mockEnv, type Row } from "./row-type.ts";

afterEach(resetModuleState);
type SearchCursor = { version: string; query: string; offset: number };
const version = "page-size-fixture";
const env = mockEnv({ CF_VERSION_METADATA: { id: version } });
const sessionId = "019ff522-3838-7662-a07c-c3b66fd871fb";
const profiles = ["/mcp", "/mcp/core", "/mcp?catalog=full"];
const endpoint = (path: string, size: string) =>
  `${path}${path.includes("?") ? "&" : "?"}search_page_size=${size}`;

async function rpc(
  path: string,
  method: string,
  params: Row = {},
  protocol = "2025-06-18",
) {
  const response = await handleMcpRequest(
    new Request(`https://mcp.invalid${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-protocol-version": protocol,
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    env,
  );
  assert.equal(response.status, 200);
  const bytes = await response.text();
  return { bytes, body: JSON.parse(bytes) as Row };
}
const search = (path: string, args: Row, protocol?: string) =>
  rpc(
    path,
    "tools/call",
    {
      name: "search_tools",
      arguments: { conversation_id: sessionId, ...args },
    },
    protocol,
  );
const byteLength = (value: string) => Buffer.byteLength(value);

describe("opt-in MCP discovery page size", () => {
  test("only exact supported endpoint values select smaller pages", () => {
    for (const [value, expected] of [
      ["1", 1],
      ["2", 2],
      ["3", 3],
    ] as const) {
      assert.equal(
        searchToolsPageSizeForUrl(
          new URL(`https://mcp.invalid${endpoint("/mcp", value)}`),
        ),
        expected,
      );
    }
    for (const value of [
      "",
      "0",
      "4",
      "-1",
      "1.0",
      "01",
      "one",
      "Infinity",
      "NaN",
    ]) {
      assert.equal(
        searchToolsPageSizeForUrl(
          new URL(`https://mcp.invalid${endpoint("/mcp", value)}`),
        ),
        3,
      );
    }
    assert.equal(
      searchToolsPageSizeForUrl(new URL("https://mcp.invalid/mcp")),
      3,
    );
  });

  test("existing response bytes and every advertised schema remain unchanged", async () => {
    for (const path of profiles) {
      const baseline = await search(path, { query: "account" });
      assert.equal(baseline.body.result.structuredContent.tools.length, 3);
      for (const value of ["3", "", "0", "4", "01", "garbage"]) {
        assert.equal(
          (await search(endpoint(path, value), { query: "account" })).bytes,
          baseline.bytes,
        );
      }
      const listing = await rpc(path, "tools/list");
      for (const value of ["1", "2", "3"]) {
        assert.equal(
          (await rpc(endpoint(path, value), "tools/list")).bytes,
          listing.bytes,
        );
      }
    }
  });

  test("all matches retain their full definitions and ordering across mixed page sizes", () => {
    const full = listToolDefinitions();
    for (const query of [
      "account",
      "subnet",
      "get_account_history",
      "no_such_capability_987",
    ]) {
      const collect = (sizes: SearchToolsPageSize[]) => {
        const found = [];
        let cursor: SearchCursor | undefined;
        let index = 0;
        do {
          const size = sizes[index++ % sizes.length];
          const page = searchToolDefinitions(
            full,
            { query, cursor },
            version,
            size,
          );
          assert.ok(page.tools.length <= size);
          found.push(...page.tools);
          cursor = page.next_cursor ?? undefined;
          if (cursor) assert.equal(cursor.offset, found.length);
        } while (cursor);
        return found;
      };
      assert.deepEqual(collect([1]), collect([3]));
      assert.deepEqual(collect([2]), collect([3]));
      assert.deepEqual(collect([1, 3, 2]), collect([3]));
    }
  });

  test("per-request configuration is isolated even for concurrent calls sharing a session", async () => {
    for (const path of profiles) {
      for (const protocol of ["2025-06-18", "2025-03-26"]) {
        const before = await search(path, { query: "account" }, protocol);
        const defaults = before.body.result.structuredContent;
        const results = await Promise.all(
          [1, 2, 3].map(async (size) => ({
            size,
            ...(await search(
              endpoint(path, String(size)),
              { query: "account" },
              protocol,
            )),
          })),
        );
        for (const { size, body } of results) {
          const result = body.result.structuredContent;
          assert.equal(body.result.isError, false);
          assert.deepEqual(result.tools, defaults.tools.slice(0, size));
          assert.equal(result.total, defaults.total);
          assert.equal(result.next_cursor.offset, size);
          const next = await search(
            path,
            { query: "account", cursor: result.next_cursor },
            protocol,
          );
          assert.deepEqual(
            next.body.result.structuredContent.tools,
            searchToolDefinitions(
              listToolDefinitions(),
              { query: "account", cursor: result.next_cursor },
              version,
            ).tools,
          );
        }
        assert.equal(
          (await search(path, { query: "account" }, protocol)).bytes,
          before.bytes,
        );
      }
    }
  });

  test("cursor errors, strict input validation and exact-name results preserve response bytes", async () => {
    const baseline = await search("/mcp", { query: "account" });
    const cursor = baseline.body.result.structuredContent.next_cursor;
    for (const args of [
      { query: "account", cursor: { ...cursor, version: "changed" } },
      { query: "account", cursor: { ...cursor, query: "changed" } },
      { query: "account", limit: 1 },
      { query: "account", cursor: { ...cursor, offset: 10001 } },
      { query: "account", cursor: { ...cursor, offset: 10000 } },
      { query: "no_such_capability_987" },
      { query: "get_account_history" },
    ]) {
      const expected = await search("/mcp", args);
      for (const size of ["1", "2"])
        assert.equal(
          (await search(endpoint("/mcp", size), args)).bytes,
          expected.bytes,
        );
    }
  });

  test("reports real HTTP payload savings separately from catalog and production latency", async () => {
    const fixtures = [];
    for (const protocol of ["2025-06-18", "2025-03-26"]) {
      for (const query of ["account", "subnet"]) {
        const responses = await Promise.all(
          [3, 2, 1].map((size) =>
            search(endpoint("/mcp", String(size)), { query }, protocol),
          ),
        );
        const [defaultBytes, twoBytes, oneBytes] = responses.map(({ bytes }) =>
          byteLength(bytes),
        );
        assert.ok(oneBytes < twoBytes && twoBytes < defaultBytes);
        fixtures.push({
          protocol,
          query,
          defaultBytes,
          twoBytes,
          oneBytes,
          onePageReductionPercent: 100 * (1 - oneBytes / defaultBytes),
        });
      }
    }
    const catalogs = await Promise.all(
      profiles.map(async (path) => {
        const { bytes, body } = await rpc(path, "tools/list");
        return {
          path,
          tools: body.result.tools.length,
          httpResponseBytes: byteLength(bytes),
        };
      }),
    );
    console.log(
      "MCP_CONTEXT_PAGE_FIXTURE",
      JSON.stringify({
        runtime: process.version,
        fixtures,
        catalogs,
        measurement:
          "raw UTF-8 HTTP response bytes in remote CI; no tokenizer or production latency claim",
      }),
    );
  });
});
