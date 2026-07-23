import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  MCP_INITIALIZE_EVENT,
  MCP_REDACTED_PLACEHOLDER,
  MCP_TOOL_CALL_EVENT,
  POSTHOG_PROJECT_TOKEN_ENV,
  mcpToolCallProperties,
} from "../src/usage-telemetry.ts";
import { handleMcpRequest } from "../src/mcp-server.mjs";

const CONFIGURED_ENV = { [POSTHOG_PROJECT_TOKEN_ENV]: "phc_test_token" };
const TOOL = "get_contracts";
const SECRET = "Bearer FAKESECRET_w1x2y3z4a5b6c7d8e9f0";

// Collects what each tools/call hands the recorder, plus what it hands
// waitUntil, without going anywhere near PostHog.
function recorder({ result = true } = {}) {
  const events = [];
  return {
    events,
    recordUsageEvent(env, event) {
      events.push({ kind: "usage_event", env, event });
      return typeof result === "function" ? result() : result;
    },
  };
}

function mcpAnalyticsRecorder({ result = true } = {}) {
  const events = [];
  return {
    events,
    recordMcpToolCallEvent(env, event) {
      events.push({ kind: MCP_TOOL_CALL_EVENT, env, event });
      return typeof result === "function" ? result() : result;
    },
    recordMcpInitializeEvent(env, event) {
      events.push({ kind: MCP_INITIALIZE_EVENT, env, event });
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
    // Drained through waitUntil rather than awaited in the tool path.
    // usage_event + $mcp_tool_call each schedule one waitUntil.
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
    const mcpSpy = mcpAnalyticsRecorder();
    const payload = await callMcp(
      toolCall(TOOL),
      {},
      {
        executionCtx: fakeExecutionCtx(),
        recordUsageEvent: spy.recordUsageEvent,
        recordMcpToolCallEvent: mcpSpy.recordMcpToolCallEvent,
      },
    );

    assert.equal(payload.result.isError, false);
    assert.deepEqual(spy.events, []);
    assert.deepEqual(mcpSpy.events, []);
  });

  test("does not record tools/list — only tool invocations", async () => {
    const spy = recorder();
    const mcpSpy = mcpAnalyticsRecorder();
    await callMcp(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      CONFIGURED_ENV,
      {
        executionCtx: fakeExecutionCtx(),
        recordUsageEvent: spy.recordUsageEvent,
        recordMcpToolCallEvent: mcpSpy.recordMcpToolCallEvent,
      },
    );

    assert.deepEqual(spy.events, []);
    assert.deepEqual(mcpSpy.events, []);
  });

  test("falls back to the real recorder when none is injected", async () => {
    // Exercises the default path end-to-end: no injected recorder, so the
    // module's own recordUsageEvent / recordMcpToolCallEvent run and post
    // through the platform fetch.
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
      assert.equal(posted.length, 2);
      const byEvent = Object.fromEntries(
        posted.map((p) => [p.body.event, p.body]),
      );
      assert.equal(byEvent.usage_event.properties.mcp_tool, TOOL);
      assert.equal(byEvent.usage_event.properties.ok, true);
      assert.equal("error_code" in byEvent.usage_event.properties, false);
      assert.equal(
        byEvent[MCP_TOOL_CALL_EVENT].properties.$mcp_tool_name,
        TOOL,
      );
      assert.equal(
        byEvent[MCP_TOOL_CALL_EVENT].properties.$mcp_is_error,
        false,
      );
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
      const usage = posted.find((p) => p.body.event === "usage_event");
      assert.equal(usage.body.properties.ok, false);
      assert.equal(usage.body.properties.error_code, "invalid_params");
      const mcp = posted.find((p) => p.body.event === MCP_TOOL_CALL_EVENT);
      assert.equal(mcp.body.properties.$mcp_is_error, true);
      assert.equal(mcp.body.properties.$mcp_error_type, "invalid_params");
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
        recordMcpToolCallEvent: mcpAnalyticsRecorder({
          result: () => Promise.reject(new Error("posthog down")),
        }).recordMcpToolCallEvent,
        executionCtx: fakeExecutionCtx(),
      },
      "recorder throws synchronously": {
        recordUsageEvent: recorder({
          result: () => {
            throw new Error("recorder exploded");
          },
        }).recordUsageEvent,
        recordMcpToolCallEvent: mcpAnalyticsRecorder({
          result: () => {
            throw new Error("recorder exploded");
          },
        }).recordMcpToolCallEvent,
        executionCtx: fakeExecutionCtx(),
      },
      "waitUntil throws": {
        recordUsageEvent: recorder().recordUsageEvent,
        recordMcpToolCallEvent: mcpAnalyticsRecorder().recordMcpToolCallEvent,
        executionCtx: {
          waitUntil() {
            throw new Error("isolate already finished");
          },
        },
      },
      "no ExecutionContext at all": {
        recordUsageEvent: recorder().recordUsageEvent,
        recordMcpToolCallEvent: mcpAnalyticsRecorder().recordMcpToolCallEvent,
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

describe("MCP native PostHog analytics (#7737)", () => {
  test("initialize emits $mcp_initialize with client/server identity", async () => {
    const spy = mcpAnalyticsRecorder();
    const executionCtx = fakeExecutionCtx();
    await callMcp(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "cursor", version: "1.2.3" },
        },
      },
      CONFIGURED_ENV,
      {
        executionCtx,
        recordMcpInitializeEvent: spy.recordMcpInitializeEvent,
      },
    );

    assert.equal(spy.events.length, 1);
    assert.equal(spy.events[0].kind, MCP_INITIALIZE_EVENT);
    assert.equal(spy.events[0].event.clientName, "cursor");
    assert.equal(spy.events[0].event.clientVersion, "1.2.3");
    assert.equal(spy.events[0].event.serverName, "metagraphed");
    assert.equal(typeof spy.events[0].event.serverVersion, "string");
    assert.equal(executionCtx.scheduled.length, 1);
  });

  test("a credentialed call_subnet_surface never leaks the raw secret on the wire", async () => {
    const original = globalThis.fetch;
    const posted = [];
    globalThis.fetch = async (_url, init) => {
      // Capture analytics posts; also satisfy any outbound surface call.
      if (typeof init?.body === "string") {
        try {
          posted.push(JSON.parse(init.body));
        } catch {
          posted.push({ raw: init.body });
        }
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => "{}",
      };
    };
    try {
      const executionCtx = fakeExecutionCtx();
      await callMcp(
        toolCall("call_subnet_surface", {
          surface_id: "does-not-exist",
          credential: {
            name: "Authorization",
            value: SECRET,
            location: "header",
          },
        }),
        CONFIGURED_ENV,
        { executionCtx },
      );
      await Promise.all(executionCtx.scheduled);

      const mcpCall = posted.find((p) => p.event === MCP_TOOL_CALL_EVENT);
      assert.ok(mcpCall, "expected a $mcp_tool_call capture");
      assert.equal(
        mcpCall.properties.$mcp_parameters.credential,
        MCP_REDACTED_PLACEHOLDER,
      );
      const wire = JSON.stringify(posted);
      assert.equal(wire.includes(SECRET), false);
      assert.equal(wire.includes("sk-live-credential-must-never-leak"), false);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("scheduled tool-call analytics redact credentials before capture properties", () => {
    // The scheduler hands the raw args object to recordMcpToolCallEvent; the
    // property builder is the redaction boundary that must never leak.
    const props = mcpToolCallProperties({
      toolName: "call_subnet_surface",
      parameters: {
        surface_id: "x:api:1",
        credential: {
          name: "Authorization",
          value: SECRET,
          location: "header",
        },
        owner_token: "owner-secret-value",
      },
      response: {
        isError: true,
        structuredContent: { error: { code: "not_found" } },
      },
      durationMs: 4,
      isError: true,
      errorType: "not_found",
    });
    assert.equal(props.$mcp_parameters.credential, MCP_REDACTED_PLACEHOLDER);
    assert.equal(props.$mcp_parameters.owner_token, MCP_REDACTED_PLACEHOLDER);
    assert.equal(JSON.stringify(props).includes(SECRET), false);
    assert.equal(JSON.stringify(props).includes("owner-secret-value"), false);
  });
});
