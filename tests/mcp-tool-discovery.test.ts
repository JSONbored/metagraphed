import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  authRequiredToolsIn,
  handleMcpRequest,
  listToolDefinitions,
} from "../src/mcp-server.ts";
import {
  SearchToolsInputSchema,
  searchToolDefinitions,
} from "../src/mcp-tool-discovery.ts";
import { POSTHOG_PROJECT_TOKEN_ENV } from "../src/usage-telemetry.ts";
import { mockEnv, type Row } from "./row-type.ts";

async function call(
  name: string,
  args: unknown,
  profile = "/mcp/core",
  protocol = "2025-06-18",
) {
  const events: Row[] = [];
  const response = await handleMcpRequest(
    new Request(`https://api.metagraph.sh${profile}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-protocol-version": protocol,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name,
          arguments:
            args && typeof args === "object" && !Array.isArray(args)
              ? {
                  conversation_id: "019ff522-3838-7662-a07c-c3b66fd871fb",
                  ...args,
                }
              : args,
        },
      }),
    }),
    mockEnv({ [POSTHOG_PROJECT_TOKEN_ENV]: "phc_test_token" }),
    {
      executionCtx: { waitUntil() {} },
      recordMcpToolCallEvent: (_env, event) => {
        events.push(event);
        return true;
      },
    },
  );
  return { response, body: (await response.json()) as Row, events };
}

describe("bounded tool discovery", () => {
  test("exact discovery preserves every advertised field and substantially reduces context", async () => {
    const full = listToolDefinitions();
    const { body } = await call("search_tools", {
      query: "get_account_history",
    });
    assert.equal(body.result.isError, false);
    assert.deepEqual(body.result.structuredContent, {
      tools: full.filter((tool) => tool.name === "get_account_history"),
      total: 1,
      next_cursor: null,
    });
    const selected = JSON.stringify(body.result.structuredContent).length;
    const whole = JSON.stringify(full).length;
    assert.ok(selected < whole / 20);
    console.log(
      JSON.stringify({
        catalogBytes: whole,
        selectedDefinitionBytes: selected,
        coreBytes: JSON.stringify(listToolDefinitions("core")).length,
      }),
    );
  });

  test("keyword pagination reaches every match without altering definitions", () => {
    const full = listToolDefinitions();
    const expected = full.filter((tool) =>
      `${tool.name} ${tool.title} ${tool.description}`
        .toLowerCase()
        .includes("account"),
    );
    const found = [];
    let cursor: { version: string; query: string; offset: number } | undefined;
    do {
      const page = searchToolDefinitions(
        full,
        { query: "account", cursor },
        "test-catalog",
      );
      assert.ok(page.tools.length <= 3);
      assert.equal(page.total, expected.length);
      found.push(...page.tools);
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    assert.deepEqual(found, expected);
    assert.deepEqual(
      searchToolDefinitions(
        full,
        { query: "no_such_capability_987" },
        "test-catalog",
      ),
      { tools: [], total: 0, next_cursor: null },
    );
    assert.equal(
      searchToolDefinitions(full, { query: "ACCOUNT HISTORY" }, "test-catalog")
        .total > 0,
      true,
    );
    assert.deepEqual(
      searchToolDefinitions(
        full,
        {
          query: "get_account_history",
          cursor: {
            version: "test-catalog",
            query: "get_account_history",
            offset: 10000,
          },
        },
        "test-catalog",
      ).tools,
      [],
    );
    assert.equal(
      SearchToolsInputSchema.parse({ query: " get_account_history " }).query,
      "get_account_history",
    );
  });

  test("continuations reject a changed catalog or query", async () => {
    const first = await call("search_tools", { query: "account" });
    const cursor = first.body.result.structuredContent.next_cursor;
    assert.ok(cursor);
    const second = await call("search_tools", { query: "account", cursor });
    assert.equal(second.body.result.isError, false);
    assert.notEqual(
      second.body.result.structuredContent.tools[0].name,
      first.body.result.structuredContent.tools[0].name,
    );
    for (const changed of [
      { ...cursor, version: "different-deployment" },
      { ...cursor, query: "different-query" },
    ]) {
      const result = await call("search_tools", {
        query: "account",
        cursor: changed,
      });
      assert.equal(result.body.result.isError, true);
      assert.match(
        result.body.result.structuredContent.error.message,
        /restart/,
      );
    }
  });

  test("both profiles advertise the callable bridge with conservative annotations", () => {
    for (const profile of ["full", "core"] as const) {
      const tools = listToolDefinitions(profile);
      assert.ok(tools.some((tool) => tool.name === "search_tools"));
      assert.deepEqual(
        tools.find((tool) => tool.name === "invoke_tool")?.annotations,
        {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      );
    }
  });

  test("invalid discovery requests fail without data reads", async () => {
    for (const args of [
      {},
      { query: " " },
      { query: "x".repeat(201) },
      {
        query: "account",
        cursor: { version: "x", query: "account", offset: -1 },
      },
      {
        query: "account",
        cursor: { version: "x", query: "account", offset: 10001 },
      },
      { query: "account", unexpected: true },
    ]) {
      const { body } = await call("search_tools", args);
      assert.equal(body.result.isError, true);
      assert.equal(body.result.structuredContent.error.code, "invalid_params");
    }
  });
});

describe("discovered invocation preserves the target dispatcher", () => {
  test("modern and legacy results equal direct calls on both profiles", async () => {
    for (const profile of ["/mcp", "/mcp/core"]) {
      for (const protocol of ["2025-06-18", "2025-03-26"]) {
        const direct = await call("get_networks", {}, profile, protocol);
        const bridge = await call(
          "invoke_tool",
          { name: "get_networks", arguments: {} },
          profile,
          protocol,
        );
        assert.deepEqual(bridge.body.result, direct.body.result);
        assert.equal(bridge.events.length, 1);
        assert.equal(bridge.events[0].toolName, "get_networks");
      }
    }
  });

  test("outer intent, conversation and model reach exactly one target event", async () => {
    const { body, events } = await call("invoke_tool", {
      name: "get_more_tools",
      arguments: {},
      context: "need retained history",
      conversation_id: "discovery-session",
      llm_model: "test-model",
    });
    assert.equal(body.result.isError, false);
    assert.equal(events.length, 1);
    assert.equal(events[0].intent, "need retained history");
    assert.equal(events[0].toolName, "get_more_tools");
    assert.deepEqual(events[0].parameters, {});
    assert.match(JSON.stringify(body.result.content), /conversation_id/);
  });

  test("target errors and unknown names match direct invocation", async () => {
    for (const [name, args] of [
      ["get_account_history", { unexpected: true }],
      ["missing_target", {}],
    ] as const) {
      const direct = await call(name, args);
      const bridge = await call("invoke_tool", { name, arguments: args });
      assert.equal(bridge.body.result.isError, true);
      assert.deepEqual(bridge.body.result, direct.body.result);
      assert.equal(bridge.events.length, 1);
    }
  });

  test("invalid and recursive envelopes cannot execute a target", async () => {
    for (const args of [
      null,
      [],
      {},
      { name: "get_more_tools" },
      { name: "invoke_tool", arguments: {} },
      { name: "get_more_tools", arguments: null },
      { name: "get_more_tools", arguments: {}, extra: true },
    ]) {
      const { body, events } = await call("invoke_tool", args);
      assert.equal(body.result.isError, true);
      assert.equal(body.result.structuredContent.error.code, "invalid_params");
      assert.equal(events.length, 1);
      assert.equal(events[0].toolName, "invoke_tool");
    }
  });

  test("protected targets issue the same transport challenge, including legacy batches", async () => {
    const name = "list_surface_credentials";
    const direct = await call(name, {});
    const bridge = await call("invoke_tool", { name, arguments: {} });
    assert.equal(direct.response.status, 401);
    assert.equal(bridge.response.status, 401);
    assert.equal(
      bridge.response.headers.get("www-authenticate"),
      direct.response.headers.get("www-authenticate"),
    );
    assert.deepEqual(bridge.body, direct.body);
    assert.deepEqual(bridge.events, []);
    assert.deepEqual(
      authRequiredToolsIn([
        { method: "ping" },
        {
          method: "tools/call",
          params: { name: "invoke_tool", arguments: { name, arguments: {} } },
        },
        { method: "tools/call", params: { name: "invoke_tool" } },
      ]),
      [name],
    );
  });
});
