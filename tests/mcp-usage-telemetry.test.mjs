import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { POSTHOG_PROJECT_TOKEN_ENV } from "../src/usage-telemetry.ts";
import { handleMcpRequest } from "../src/mcp-server.mjs";

const CONFIGURED_ENV = { [POSTHOG_PROJECT_TOKEN_ENV]: "phc_test_token" };
const TOOL = "get_contracts";

// Collects what each tools/call hands the recorder, plus what it hands
// waitUntil, without going anywhere near PostHog.
function recorder({ result = true } = {}) {
  const events = [];
  return {
    events,
    recordUsageEvent(env, event) {
      events.push({ env, event });
      return typeof result === "function" ? result() : result;
    },
  };
}

function fakeExecutionCtx() {
  const scheduled = [];
  return { scheduled, waitUntil: (promise) => scheduled.push(promise) };
}

function makeDeps(extra = {}) {
  return {
    readArtifact: (_env, path) =>
      Promise.resolve({
        ok: true,
        data: { schema_version: 1, path },
        source: "test",
        storage_tier: "git",
      }),
    readHealthKv: () => Promise.resolve(null),
    ...extra,
  };
}

function toolCall(name, args = {}) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  };
}

async function callMcp(body, env, extraDeps = {}) {
  const request = new Request("https://api.metagraph.sh/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
  const response = await handleMcpRequest(request, env, makeDeps(extraDeps));
  return response.json();
}

describe("MCP tool-dispatch usage telemetry", () => {
  test("records exactly one event per tool call, keyed by tool name", async () => {
    const spy = recorder();
    const executionCtx = fakeExecutionCtx();

    const payload = await callMcp(toolCall(TOOL), CONFIGURED_ENV, {
      executionCtx,
      recordUsageEvent: spy.recordUsageEvent,
    });

    assert.equal(payload.result.isError, false);
    assert.equal(spy.events.length, 1);
    const { env, event } = spy.events[0];
    assert.equal(env, CONFIGURED_ENV);
    assert.equal(event.mcpTool, TOOL);
    assert.equal(event.ok, true);
    assert.equal(typeof event.durationMs, "number");
    assert.ok(event.durationMs >= 0);
    // Never the arguments, never the response content.
    assert.deepEqual(Object.keys(event).sort(), [
      "durationMs",
      "mcpTool",
      "ok",
    ]);
    // Drained through waitUntil rather than awaited in the tool path -- one
    // usage_event plus one $mcp_tool_call (metagraphed#7737).
    assert.equal(executionCtx.scheduled.length, 2);
  });

  test("records an unknown tool as a failure", async () => {
    const spy = recorder();
    const payload = await callMcp(
      toolCall("no_such_tool_at_all"),
      CONFIGURED_ENV,
      {
        executionCtx: fakeExecutionCtx(),
        recordUsageEvent: spy.recordUsageEvent,
      },
    );

    assert.equal(payload.result.isError, true);
    assert.equal(spy.events.length, 1);
    assert.equal(spy.events[0].event.mcpTool, "no_such_tool_at_all");
    assert.equal(spy.events[0].event.ok, false);
    // metagraphed#7726: the one isError path with no toolError behind it
    // still gets its own literal code.
    assert.equal(spy.events[0].event.errorCode, "unknown_tool");
  });

  test("records a failing tool as a failure, categorized by its toolError code (#7726)", async () => {
    const spy = recorder();
    // Invalid arguments — the tool returns an isError result rather than throwing.
    const payload = await callMcp(
      toolCall("get_subnet", { netuid: "not-a-netuid" }),
      CONFIGURED_ENV,
      {
        executionCtx: fakeExecutionCtx(),
        recordUsageEvent: spy.recordUsageEvent,
      },
    );

    assert.equal(payload.result.isError, true);
    assert.equal(spy.events.length, 1);
    assert.equal(spy.events[0].event.ok, false);
    assert.equal(spy.events[0].event.errorCode, "invalid_params");
  });

  test("omits errorCode entirely on a successful call (no key, not just falsy)", async () => {
    const spy = recorder();
    await callMcp(toolCall(TOOL), CONFIGURED_ENV, {
      executionCtx: fakeExecutionCtx(),
      recordUsageEvent: spy.recordUsageEvent,
    });

    assert.equal(spy.events.length, 1);
    assert.equal("errorCode" in spy.events[0].event, false);
  });

  test("does no telemetry work when the deployment is unconfigured", async () => {
    const spy = recorder();
    const payload = await callMcp(
      toolCall(TOOL),
      {},
      {
        executionCtx: fakeExecutionCtx(),
        recordUsageEvent: spy.recordUsageEvent,
      },
    );

    assert.equal(payload.result.isError, false);
    assert.deepEqual(spy.events, []);
  });

  test("does not record tools/list — only tool invocations", async () => {
    const spy = recorder();
    await callMcp(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      CONFIGURED_ENV,
      {
        executionCtx: fakeExecutionCtx(),
        recordUsageEvent: spy.recordUsageEvent,
      },
    );

    assert.deepEqual(spy.events, []);
  });

  test("falls back to the real recorder when none is injected", async () => {
    // Exercises the default path end-to-end: no injected recorder, so the
    // module's own recordUsageEvent runs and posts through the platform fetch.
    const original = globalThis.fetch;
    const posted = [];
    globalThis.fetch = async (url, init) => {
      posted.push({ url, body: JSON.parse(init.body) });
      return { ok: true };
    };
    try {
      const executionCtx = fakeExecutionCtx();
      const payload = await callMcp(toolCall(TOOL), CONFIGURED_ENV, {
        executionCtx,
      });
      await Promise.all(executionCtx.scheduled);

      assert.equal(payload.result.isError, false);
      // usage_event plus its $mcp_tool_call sibling (metagraphed#7737).
      assert.equal(posted.length, 2);
      const usage = posted.find((c) => c.body.event === "usage_event");
      assert.ok(usage);
      assert.equal(usage.body.properties.mcp_tool, TOOL);
      assert.equal(usage.body.properties.ok, true);
      assert.equal("error_code" in usage.body.properties, false);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("posts a snake_case error_code on the real wire format for a failing call (#7726)", async () => {
    const original = globalThis.fetch;
    const posted = [];
    globalThis.fetch = async (url, init) => {
      posted.push({ url, body: JSON.parse(init.body) });
      return { ok: true };
    };
    try {
      const executionCtx = fakeExecutionCtx();
      const payload = await callMcp(
        toolCall("get_subnet", { netuid: "not-a-netuid" }),
        CONFIGURED_ENV,
        { executionCtx },
      );
      await Promise.all(executionCtx.scheduled);

      assert.equal(payload.result.isError, true);
      // usage_event plus its $mcp_tool_call sibling (metagraphed#7737).
      assert.equal(posted.length, 2);
      const usage = posted.find((c) => c.body.event === "usage_event");
      assert.ok(usage);
      assert.equal(usage.body.properties.ok, false);
      assert.equal(usage.body.properties.error_code, "invalid_params");
    } finally {
      globalThis.fetch = original;
    }
  });

  test("records one event per call in a batch", async () => {
    const spy = recorder();
    await callMcp([toolCall(TOOL), toolCall(TOOL)], CONFIGURED_ENV, {
      executionCtx: fakeExecutionCtx(),
      recordUsageEvent: spy.recordUsageEvent,
    });

    assert.equal(spy.events.length, 2);
  });

  // The regression the issue asks for: a telemetry failure must never become a
  // tool failure. Each shape is compared against the untelemetried response, so
  // this asserts byte-identical behavior rather than merely "not an error".
  test("a telemetry failure changes nothing about the tool result", async () => {
    const baseline = await callMcp(toolCall(TOOL), {});
    assert.equal(baseline.result.isError, false);

    const failureModes = {
      "recorder rejects": {
        recordUsageEvent: recorder({
          result: () => Promise.reject(new Error("posthog down")),
        }).recordUsageEvent,
        executionCtx: fakeExecutionCtx(),
      },
      "recorder throws synchronously": {
        recordUsageEvent: recorder({
          result: () => {
            throw new Error("recorder exploded");
          },
        }).recordUsageEvent,
        executionCtx: fakeExecutionCtx(),
      },
      "waitUntil throws": {
        recordUsageEvent: recorder().recordUsageEvent,
        executionCtx: {
          waitUntil() {
            throw new Error("isolate already finished");
          },
        },
      },
      "no ExecutionContext at all": {
        recordUsageEvent: recorder().recordUsageEvent,
      },
    };

    for (const [mode, deps] of Object.entries(failureModes)) {
      const payload = await callMcp(toolCall(TOOL), CONFIGURED_ENV, deps);
      assert.deepEqual(
        payload,
        baseline,
        `telemetry mode changed the result: ${mode}`,
      );
    }
  });
});

// metagraphed#7737: the PostHog-native $mcp_* analytics family, recorded
// through its own injectable seam. The recorder receives RAW parameters and
// response -- redaction/capping is recordMcpAnalyticsEvent's job (unit-tested
// in usage-telemetry.test.mjs); what matters here is that dispatch hands the
// analytics pipeline exactly one complete event per lifecycle point.
describe("PostHog-native MCP analytics ($mcp_*)", () => {
  function analyticsRecorder() {
    const events = [];
    return {
      events,
      recordMcpAnalyticsEvent(env, event) {
        events.push({ env, event });
        return true;
      },
    };
  }

  test("initialize records one $mcp_initialize event with the handshake params", async () => {
    const spy = analyticsRecorder();
    const payload = await callMcp(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          clientInfo: { name: "vitest", version: "1.0.0" },
        },
      },
      CONFIGURED_ENV,
      {
        executionCtx: fakeExecutionCtx(),
        recordMcpAnalyticsEvent: spy.recordMcpAnalyticsEvent,
      },
    );

    assert.ok(payload.result.serverInfo);
    assert.equal(spy.events.length, 1);
    const { env, event } = spy.events[0];
    assert.equal(env, CONFIGURED_ENV);
    assert.equal(event.type, "initialize");
    assert.equal(event.parameters.clientInfo.name, "vitest");
  });

  test("a tool call records one $mcp_tool_call with raw args and response for central redaction", async () => {
    const spy = analyticsRecorder();
    const executionCtx = fakeExecutionCtx();
    const payload = await callMcp(toolCall(TOOL), CONFIGURED_ENV, {
      executionCtx,
      recordMcpAnalyticsEvent: spy.recordMcpAnalyticsEvent,
    });

    assert.equal(payload.result.isError, false);
    assert.equal(spy.events.length, 1);
    const { event } = spy.events[0];
    assert.equal(event.type, "tool_call");
    assert.equal(event.toolName, TOOL);
    assert.equal(event.ok, true);
    assert.ok(event.durationMs >= 0);
    assert.deepEqual(event.parameters, {});
    assert.deepEqual(event.response, payload.result.structuredContent);
    assert.equal("errorCode" in event, false);
  });

  test("a failing tool call carries the same fixed literal errorCode", async () => {
    const spy = analyticsRecorder();
    const payload = await callMcp(
      toolCall("get_subnet", { netuid: "not-a-netuid" }),
      CONFIGURED_ENV,
      {
        executionCtx: fakeExecutionCtx(),
        recordMcpAnalyticsEvent: spy.recordMcpAnalyticsEvent,
      },
    );

    assert.equal(payload.result.isError, true);
    assert.equal(spy.events.length, 1);
    assert.equal(spy.events[0].event.ok, false);
    assert.equal(spy.events[0].event.errorCode, "invalid_params");
  });

  test("does no analytics work when the deployment is unconfigured", async () => {
    const spy = analyticsRecorder();
    await callMcp(
      toolCall(TOOL),
      {},
      {
        executionCtx: fakeExecutionCtx(),
        recordMcpAnalyticsEvent: spy.recordMcpAnalyticsEvent,
      },
    );
    assert.deepEqual(spy.events, []);
  });

  test("an analytics recorder failure changes nothing about the tool result", async () => {
    const baseline = await callMcp(toolCall(TOOL), {});
    const payload = await callMcp(toolCall(TOOL), CONFIGURED_ENV, {
      executionCtx: fakeExecutionCtx(),
      recordUsageEvent: recorder().recordUsageEvent,
      recordMcpAnalyticsEvent: () => {
        throw new Error("analytics exploded");
      },
    });
    assert.deepEqual(payload, baseline);
  });
});
