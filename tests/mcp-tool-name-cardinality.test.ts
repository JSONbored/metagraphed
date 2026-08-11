// `$mcp_tool_name` must not be writable by strangers.
//
// `params.name` on a tools/call is caller-supplied and became the tool label on
// two events -- usage_event's `mcpTool` and PostHog's `$mcp_tool_name`. An
// unregistered name passed straight through, so anyone could mint an unbounded
// number of distinct property values by looping tools/call over random names.
//
// This is the same defect MCP_LABELLED_METHODS already prevents for `method`,
// whose own comment warns that "getting it right in one place and wrong in the
// next is how that class of bug survives". It survived here: the project's live
// `$mcp_tool_name` breakdown carries 30+ single-use values from one third-party
// verifier's per-run probe name (`__verifymcp_auth_probe_<hash>__`) alongside
// the real 232, on a free-tier plan.
//
// What must NOT be lost to the fix: "agents are guessing tool names" stays
// countable. dispatchTool's `unknown_tool` code is the dimension that carries
// it, and the guessed name is still readable in the parameters payload.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { POSTHOG_PROJECT_TOKEN_ENV } from "../src/usage-telemetry.ts";
import { handleMcpRequest, listToolDefinitions } from "../src/mcp-server.ts";
import type { Row } from "./row-type.ts";

const CONFIGURED_ENV = { [POSTHOG_PROJECT_TOKEN_ENV]: "phc_test_token" };
const UNREGISTERED = "unregistered_tool";

function makeDeps(extra: Row = {}) {
  return {
    readArtifact: (_env: Row, path: string) =>
      Promise.resolve({
        ok: true,
        data: { schema_version: 1, path },
        source: "test",
        storage_tier: "git",
      }),
    readHealthKv: () => Promise.resolve(null),
    executionCtx: { waitUntil: () => {} },
    ...extra,
  };
}

/** Drives one tools/call and returns both telemetry events it scheduled. */
async function capture(name: string, args: Row = {}) {
  const usage: Row[] = [];
  const mcp: Row[] = [];
  const response = await handleMcpRequest(
    new Request("https://api.metagraph.sh/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
    CONFIGURED_ENV as unknown as Env,
    makeDeps({
      recordUsageEvent: (_env: unknown, event: Row) => {
        usage.push(event);
        return true;
      },
      recordMcpToolCallEvent: (_env: unknown, event: Row) => {
        mcp.push(event);
        return true;
      },
    }),
  );
  const body = (await response.json()) as Row;
  return { usage, mcp, body };
}

describe("unregistered tool names are bucketed, not recorded verbatim", () => {
  // The exact shape observed in production, plus the two other ways a caller
  // reaches this path.
  for (const [label, name] of Object.entries({
    "a third-party verifier's per-run probe":
      "__verifymcp_auth_probe_f19d1e17e7bb1717__",
    "a second run of the same verifier":
      "__verifymcp_auth_probe_266c0a0e3e53c5b8__",
    "an agent guessing a plausible name": "get_subnet_emissions",
    "a scanner sending junk": "nope_not_a_tool",
  })) {
    test(`folds ${label} into one bucket`, async () => {
      const { usage, mcp } = await capture(name);

      assert.equal(usage.length, 1);
      assert.equal(mcp.length, 1);
      // Neither event may carry the caller's string.
      assert.equal(usage[0].mcpTool, UNREGISTERED);
      assert.equal(mcp[0].toolName, UNREGISTERED);
      assert.ok(
        !JSON.stringify(usage[0]).includes(name),
        "usage_event must not carry the caller-supplied name",
      );
    });
  }

  test("two different unregistered names produce ONE label, not two", async () => {
    // The property being protected, stated directly: cardinality. Asserting
    // each call individually would still pass if the bucket were derived from
    // the name.
    const first = await capture("__verifymcp_auth_probe_aaaaaaaaaaaaaaaa__");
    const second = await capture("__verifymcp_auth_probe_bbbbbbbbbbbbbbbb__");

    const labels = new Set([
      first.mcp[0].toolName as string,
      second.mcp[0].toolName as string,
    ]);
    assert.deepEqual([...labels], [UNREGISTERED]);
  });

  test("the failure stays countable and attributable", async () => {
    const { mcp, usage, body } = await capture("nope_not_a_tool");

    // The dimension that answers "are agents guessing tool names".
    assert.equal(mcp[0].errorCode, "unknown_tool");
    assert.equal(usage[0].errorCode, "unknown_tool");
    assert.equal(mcp[0].isError, true);
    // And the caller still gets the name it got wrong, in the tool result --
    // the bucketing is an analytics concern, not a response change.
    assert.match(
      String((body?.result?.content as Row[])?.[0]?.text),
      /nope_not_a_tool/,
    );
  });

  // Proving the bucket is not applied to everything: without this, a
  // mcpToolLabel that returned the sentinel unconditionally would pass every
  // assertion above.
  test("a registered tool is still recorded under its own name", async () => {
    const { usage, mcp } = await capture("get_contracts");

    assert.equal(usage[0].mcpTool, "get_contracts");
    assert.equal(mcp[0].toolName, "get_contracts");
    assert.equal(mcp[0].isError, false);
  });

  test("every advertised tool survives the bucket", async () => {
    // Derived from the served catalogue rather than a sample, so a tool
    // registered tomorrow is covered tonight -- and so a mcpToolLabel keyed on
    // a stale list cannot pass.
    const names = listToolDefinitions().map((tool: Row) => tool.name as string);
    assert.ok(
      names.length > 200,
      `expected the full catalogue, got ${names.length}`,
    );

    const { mcp } = await capture(names[0]);
    assert.equal(mcp[0].toolName, names[0]);
    assert.notEqual(mcp[0].toolName, UNREGISTERED);
  });
});
