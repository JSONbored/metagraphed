import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { handleMcpRequest } from "../src/mcp-server.mjs";
import { POSTHOG_PROJECT_TOKEN_ENV } from "../src/usage-telemetry.mjs";
import { handleRequest } from "../workers/api.mjs";

const MCP_URL = "https://api.metagraph.sh/mcp";

function makeDeps(artifacts = {}, extras = {}) {
  return {
    readArtifact(_env, path) {
      if (Object.prototype.hasOwnProperty.call(artifacts, path)) {
        return Promise.resolve({
          ok: true,
          data: artifacts[path],
          source: "test",
          storage_tier: "git",
        });
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        code: "artifact_not_found",
        message: `Artifact not found: ${path}`,
      });
    },
    readHealthKv() {
      return Promise.resolve(null);
    },
    ...extras,
  };
}

async function callTool(name, args, { deps = makeDeps(), env = {} } = {}) {
  const request = new Request(MCP_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const response = await handleMcpRequest(request, env, deps);
  return {
    status: response.status,
    body: await response.json(),
  };
}

describe("MCP tool-dispatch usage telemetry (#6031)", () => {
  test("successful tools/call records exactly one allowlisted usage event via waitUntil", async () => {
    const events = [];
    const waitUntilPromises = [];
    const overview = {
      schema_version: 1,
      netuid: 7,
      name: "Allways",
      slug: "allways",
    };
    const res = await callTool(
      "get_subnet",
      { netuid: 7 },
      {
        deps: makeDeps(
          { "/metagraph/overview/7.json": overview },
          {
            waitUntil: (promise) => {
              waitUntilPromises.push(promise);
            },
            recordUsageEvent: async (_env, event) => {
              events.push(event);
              return true;
            },
          },
        ),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.body.result.isError, false);
    assert.equal(res.body.result.structuredContent.netuid, 7);
    assert.equal(waitUntilPromises.length, 1);
    await Promise.all(waitUntilPromises);

    assert.equal(events.length, 1);
    assert.equal(events[0].mcpTool, "get_subnet");
    assert.equal(events[0].ok, true);
    assert.equal(typeof events[0].durationMs, "number");
    assert.ok(events[0].durationMs >= 0);
    assert.equal(events[0].route, undefined);
    assert.equal(events[0].args, undefined);
  });

  test("a toolError (isError) result records ok:false without changing the error shape", async () => {
    const events = [];
    const waitUntilPromises = [];
    const res = await callTool(
      "get_subnet",
      { netuid: "seven" },
      {
        deps: makeDeps(
          {},
          {
            waitUntil: (promise) => waitUntilPromises.push(promise),
            recordUsageEvent: async (_env, event) => {
              events.push(event);
              return true;
            },
          },
        ),
      },
    );

    assert.equal(res.body.result.isError, true);
    await Promise.all(waitUntilPromises);
    assert.equal(events.length, 1);
    assert.equal(events[0].mcpTool, "get_subnet");
    assert.equal(events[0].ok, false);
  });

  test("non-string tool name omits mcpTool but still records ok:false", async () => {
    const events = [];
    const waitUntilPromises = [];
    const request = new Request(MCP_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: 123, arguments: {} },
      }),
    });
    const response = await handleMcpRequest(
      request,
      {},
      makeDeps(
        {},
        {
          waitUntil: (promise) => waitUntilPromises.push(promise),
          recordUsageEvent: async (_env, event) => {
            events.push(event);
            return true;
          },
        },
      ),
    );
    const body = await response.json();
    assert.equal(body.result.isError, true);
    await Promise.all(waitUntilPromises);
    assert.equal(events.length, 1);
    assert.equal(events[0].mcpTool, undefined);
    assert.equal(events[0].ok, false);
  });

  test("unknown tool records ok:false and still returns the usual isError body", async () => {
    const events = [];
    const waitUntilPromises = [];
    const res = await callTool(
      "definitely_not_a_tool",
      {},
      {
        deps: makeDeps(
          {},
          {
            waitUntil: (promise) => waitUntilPromises.push(promise),
            recordUsageEvent: async (_env, event) => {
              events.push(event);
              return true;
            },
          },
        ),
      },
    );

    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /Unknown tool/);
    await Promise.all(waitUntilPromises);
    assert.equal(events.length, 1);
    assert.equal(events[0].mcpTool, "definitely_not_a_tool");
    assert.equal(events[0].ok, false);
  });

  test("tool call still succeeds with its normal response when telemetry throws", async () => {
    const overview = {
      schema_version: 1,
      netuid: 7,
      name: "Allways",
      slug: "allways",
    };
    const waitUntilPromises = [];
    const res = await callTool(
      "get_subnet",
      { netuid: 7 },
      {
        deps: makeDeps(
          { "/metagraph/overview/7.json": overview },
          {
            waitUntil: (promise) => waitUntilPromises.push(promise),
            recordUsageEvent: async () => {
              throw new Error("posthog down");
            },
          },
        ),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.body.result.isError, false);
    assert.equal(res.body.result.structuredContent.netuid, 7);
    assert.equal(waitUntilPromises.length, 1);
    // The scheduled promise must settle without rejecting into the test harness.
    await assert.doesNotReject(() => Promise.all(waitUntilPromises));
  });

  test("tool call still succeeds when the injected recorder throws synchronously", async () => {
    const overview = {
      schema_version: 1,
      netuid: 7,
      name: "Allways",
      slug: "allways",
    };
    const res = await callTool(
      "get_subnet",
      { netuid: 7 },
      {
        deps: makeDeps(
          { "/metagraph/overview/7.json": overview },
          {
            recordUsageEvent: () => {
              throw new Error("sync boom");
            },
          },
        ),
      },
    );
    assert.equal(res.body.result.isError, false);
    assert.equal(res.body.result.structuredContent.netuid, 7);
  });

  test("without waitUntil, telemetry still fires (fire-and-forget) and does not block", async () => {
    const events = [];
    let resolveRecord;
    const recordGate = new Promise((resolve) => {
      resolveRecord = resolve;
    });
    const overview = {
      schema_version: 1,
      netuid: 7,
      name: "Allways",
      slug: "allways",
    };

    const res = await callTool(
      "get_subnet",
      { netuid: 7 },
      {
        deps: makeDeps(
          { "/metagraph/overview/7.json": overview },
          {
            // No waitUntil — exercises the void-pending fallback.
            recordUsageEvent: async (_env, event) => {
              await recordGate;
              events.push(event);
              return true;
            },
          },
        ),
      },
    );

    // Response returned before the deferred recorder finished.
    assert.equal(res.body.result.isError, false);
    assert.equal(events.length, 0);
    resolveRecord();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(events.length, 1);
    assert.equal(events[0].mcpTool, "get_subnet");
  });

  test("production path: real recordUsageEvent is a safe no-op when PostHog is unconfigured", async () => {
    const overview = {
      schema_version: 1,
      netuid: 7,
      name: "Allways",
      slug: "allways",
    };
    const waitUntilPromises = [];
    const res = await callTool(
      "get_subnet",
      { netuid: 7 },
      {
        env: {}, // no POSTHOG_PROJECT_TOKEN
        deps: makeDeps(
          { "/metagraph/overview/7.json": overview },
          {
            waitUntil: (promise) => waitUntilPromises.push(promise),
            // Leave recordUsageEvent unset → real recorder, unconfigured no-op.
          },
        ),
      },
    );
    assert.equal(res.body.result.isError, false);
    await Promise.all(waitUntilPromises);
    assert.equal(
      Object.prototype.hasOwnProperty.call({}, POSTHOG_PROJECT_TOKEN_ENV),
      false,
    );
  });
});

describe("workers/api MCP waitUntil threading (#6031)", () => {
  function mcpToolsCallRequest(name = "definitely_not_a_tool") {
    return new Request(MCP_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: {} },
      }),
    });
  }

  test("handleRequest threads ctx.waitUntil into MCP so usage can flush after the response", async () => {
    const waitUntilPromises = [];
    const res = await handleRequest(
      mcpToolsCallRequest(),
      {},
      {
        waitUntil: (promise) => waitUntilPromises.push(promise),
      },
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.result.isError, true);
    // One usage-event promise scheduled via the Worker executionCtx.
    assert.equal(waitUntilPromises.length, 1);
    await assert.doesNotReject(() => Promise.all(waitUntilPromises));
  });

  test("handleRequest MCP path still works when executionCtx has no waitUntil", async () => {
    const res = await handleRequest(mcpToolsCallRequest(), {}, {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.result.isError, true);
    assert.match(body.result.content[0].text, /Unknown tool/);
  });
});
