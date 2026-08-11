// An unknown-argument rejection has to name the argument it rejected.
//
// `validateToolArguments` has always refused a key the tool's inputSchema does
// not declare (additionalProperties: false). What it did NOT do was say which
// key, or what the tool would have accepted -- every one of those refusals read
// "Invalid arguments for tool <name>." and nothing else.
//
// That message was the most common live MCP failure a caller could not act on.
// Measured on production $mcp_tool_call events, the arguments agents were
// actually sending when they hit it:
//
//   get_subnet_registrations   {"limit":"5","netuid":64}   pages by `window`
//   get_validator_history      {"limit":3,"netuid":3}      pages by `window`
//   get_account_identity       {"address":"5FWh..."}       keyed on `ss58`
//   get_self_health            {"random_string":"check"}   takes nothing
//
// Each is one vocabulary list away from a correct retry, and each agent instead
// retried the identical call. These tests pin the fix to those exact shapes.
//
// What is NOT being tested here, because it deliberately does not exist: schema
// validation at dispatch. #8942 measured that and rejected it
// (tests/mcp-schema-enforcement.test.ts records why). This only changes how the
// unknown-key refusal that already happened is reported.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { handleMcpRequest, listToolDefinitions } from "../src/mcp-server.ts";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import type { Row } from "./row-type.ts";

const env = createLocalArtifactEnv() as unknown as Env;

// Artifact reads are stubbed the same way tests/mcp-usage-telemetry.test.ts
// stubs them, so the positive controls at the bottom exercise a handler that
// actually completes. The rejection cases never reach a handler.
const DEPS = {
  readArtifact: (_env: Row, path: string) =>
    Promise.resolve({
      ok: true,
      data: { schema_version: 1, path },
      source: "test",
      storage_tier: "git",
    }),
  readHealthKv: () => Promise.resolve(null),
};

async function callTool(name: string, args: unknown): Promise<Row> {
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
    env,
    DEPS,
  );
  const body = (await response.json()) as Row;
  return (body?.result?.structuredContent as Row)?.error as Row;
}

describe("unknown MCP tool arguments are reported, not just refused", () => {
  // The four shapes above, driven through the real dispatcher.
  for (const [label, { tool, args, unknownKey }] of Object.entries({
    "a limit on a tool that pages by window": {
      tool: "get_subnet_registrations",
      args: { limit: "5", netuid: 64 },
      unknownKey: "limit",
    },
    "a numeric limit on a tool that pages by window": {
      tool: "get_validator_history",
      args: { limit: 3, netuid: 3 },
      unknownKey: "limit",
    },
    "an address on a tool keyed on ss58": {
      tool: "get_account_identity",
      args: { address: "5FWh37LfVV5LE9dZA91STzbtebh6vxYa3MH71c621sYafo1L" },
      unknownKey: "address",
    },
    "filler on a tool that takes no arguments": {
      tool: "get_self_health",
      args: { random_string: "check" },
      unknownKey: "random_string",
    },
  })) {
    test(`names the rejected key and the accepted ones: ${label}`, async () => {
      const error = await callTool(tool, args);

      assert.equal(error.code, "invalid_params");
      const message = String(error.message);

      // The key the caller got wrong, quoted the way every other argument
      // guard in this server quotes one.
      assert.match(message, new RegExp(`\`${unknownKey}\``));
      // ...and the tool it was wrong for.
      assert.ok(
        message.includes(tool),
        `message should name the tool: ${message}`,
      );

      // The vocabulary that makes the retry possible: every argument the
      // served schema declares, read from the schema rather than hardcoded so
      // this cannot drift from what tools/list advertises.
      const declared = Object.keys(
        (listToolDefinitions().find((t: Row) => t.name === tool) as Row)
          ?.inputSchema?.properties ?? {},
      );
      assert.ok(declared.length > 0, `${tool} should declare arguments`);
      for (const accepted of declared) {
        assert.ok(
          message.includes(accepted),
          `message should offer \`${accepted}\`: ${message}`,
        );
      }
    });
  }

  test("names every unknown key when more than one was sent", async () => {
    const error = await callTool("get_self_health", {
      random_string: "check",
      also_wrong: 1,
    });

    assert.equal(error.code, "invalid_params");
    const message = String(error.message);
    assert.match(message, /`random_string`/);
    assert.match(message, /`also_wrong`/);
    // Plural, because two keys were wrong.
    assert.match(message, /Unknown arguments/);
  });

  // get_self_health declares only `context`, the analytics intent argument, so
  // "accepted arguments" is not empty for it. Guard the genuinely-empty branch
  // against a synthetic tool rather than pinning a real one's schema in place.
  test("says so when a tool accepts nothing at all", async () => {
    const { validateToolArguments } = await import("../src/mcp-server.ts");
    assert.throws(
      () =>
        validateToolArguments(
          {
            name: "takes_nothing",
            inputSchema: { additionalProperties: false, properties: {} },
          } as Row,
          { nope: 1 } as Row,
        ),
      (error: Error) => {
        assert.match(error.message, /`nope`/);
        assert.match(error.message, /accepts no arguments/);
        return true;
      },
    );
  });

  // The other half of the split: a non-object `arguments` is a different
  // mistake from an unknown key, and now says which one it is.
  for (const [label, args] of Object.entries({
    "an array": [1, 2, 3],
    "a string": "netuid=1",
    "a number": 7,
  })) {
    test(`rejects ${label} as a shape error, not an unknown key`, async () => {
      const error = await callTool("get_subnet_registrations", args);

      assert.equal(error.code, "invalid_params");
      const message = String(error.message);
      assert.match(message, /expected an object of named arguments/);
      // Not the unknown-key message -- there is no key to name.
      assert.doesNotMatch(message, /Unknown argument/);
    });
  }

  // Proving the gate can still pass: a correct call must not be caught by any
  // of the above. Without this, every assertion here would also hold for a
  // validateToolArguments that rejected everything.
  //
  // get_contracts is the tool the sibling telemetry suite uses for exactly this
  // reason -- it resolves from the local artifact env, so a failure here is
  // this change's fault rather than a missing live binding.
  test("a call using only declared arguments is not rejected", async () => {
    const error = await callTool("get_contracts", {});
    assert.equal(error, undefined);
  });

  test("the intent argument is still accepted, not read as unknown", async () => {
    // `context` is declared on every tool and stripped before the handler --
    // it must never read as an unknown key.
    const error = await callTool("get_contracts", {
      context: "checking whether the registry is serving",
    });
    assert.equal(error, undefined);
  });
});
