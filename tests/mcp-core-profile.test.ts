// #11164: the /mcp/core profile -- a context diet, never a capability cut.
//
// The two contracts under test: the core LISTING is exactly the declared set,
// and a core session can still CALL every tool -- the profile filters what a
// client holds in context, not what it may do.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  assertCoreNamesRegistered,
  handleMcpRequest,
  listToolDefinitions,
  MCP_CORE_TOOL_NAMES,
} from "../src/mcp-server.ts";
import { isMcpCorePath } from "../src/github-oauth.ts";
import { mockEnv, type Row } from "./row-type.ts";

const rpc = (url: string, body: unknown) =>
  handleMcpRequest(
    new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify(body),
    }),
    mockEnv(),
  );

const toolsList = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };

async function listedNames(url: string): Promise<string[]> {
  const res = await rpc(url, toolsList);
  assert.equal(res.status, 200);
  const text = await res.text();
  const json = text.startsWith("event:")
    ? JSON.parse(text.slice(text.indexOf("data:") + 5).trim())
    : JSON.parse(text);
  return ((json.result as Row).tools as Row[]).map((t) => String(t.name));
}

describe("the endpoint is the profile", () => {
  test("isMcpCorePath matches exactly the core endpoint, slash-tolerant", () => {
    assert.equal(isMcpCorePath("/mcp/core"), true);
    assert.equal(isMcpCorePath("/mcp/core/"), true);
    assert.equal(isMcpCorePath("/mcp"), false);
    assert.equal(isMcpCorePath("/mcp/"), false);
    assert.equal(isMcpCorePath("/mcp/corex"), false);
  });

  test("/mcp/core lists exactly the declared set; /mcp lists everything", async () => {
    const core = await listedNames("https://api.metagraph.sh/mcp/core");
    assert.deepEqual(
      [...core].sort(),
      [...MCP_CORE_TOOL_NAMES].sort(),
      "the core listing is the declaration, nothing more or less",
    );
    const full = await listedNames("https://api.metagraph.sh/mcp");
    assert.ok(full.length > 200, `full listing stays whole (${full.length})`);
    for (const name of core) {
      assert.ok(full.includes(name), `${name} is a subset of full`);
    }
  });

  test("the core listing is a context diet, measured", () => {
    const size = (tools: unknown) => JSON.stringify(tools).length;
    const full = size(listToolDefinitions());
    const core = size(listToolDefinitions("core"));
    // The whole point. If core creeps past a quarter of full, it has stopped
    // being a diet and someone should look at what got added.
    assert.ok(
      core < full / 4,
      `core (${core} B) must stay well under full (${full} B)`,
    );
  });
});

describe("the load guard", () => {
  test("a renamed tool fails startup with the name attached", () => {
    assert.throws(
      () => assertCoreNamesRegistered(["ask", "gone_tool"], new Set(["ask"])),
      /gone_tool/,
    );
    // And the passing arm returns the set it validated.
    const ok = assertCoreNamesRegistered(["ask"], new Set(["ask", "other"]));
    assert.ok(ok.has("ask"));
  });

  test("the trailing-slash core endpoint serves the core listing too", async () => {
    const names = await listedNames("https://api.metagraph.sh/mcp/core/");
    assert.equal(names.length, MCP_CORE_TOOL_NAMES.length);
  });
});

describe("the profile never gates a call", () => {
  test("a tool OUTSIDE the core set is callable through /mcp/core", async () => {
    // get_networks is deliberately not in the core set. A conformant refusal
    // here would be `unknown_tool`; anything else -- including a data-tier
    // error from the hermetic env -- proves dispatch accepted the name.
    assert.ok(!MCP_CORE_TOOL_NAMES.includes("get_networks"));
    const res = await rpc("https://api.metagraph.sh/mcp/core", {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "get_networks", arguments: { context: "profile test" } },
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(
      !text.includes("Unknown tool"),
      "a non-core tool must dispatch on the core endpoint",
    );
  });
});
