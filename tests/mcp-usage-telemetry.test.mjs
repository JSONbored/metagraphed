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
    // Drained through waitUntil rather than awaited in the tool path.
    // Two promises: one for usage_event, one for $mcp_tool_call.
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
      // Two events: usage_event (existing telemetry) + $mcp_tool_call (MCP analytics).
      assert.equal(posted.length, 2);
      const usagePost = posted.find((p) => p.body.event === "usage_event");
      assert.ok(usagePost, "usage_event should be posted");
      assert.equal(usagePost.body.properties.mcp_tool, TOOL);
      assert.equal(usagePost.body.properties.ok, true);
      assert.equal("error_code" in usagePost.body.properties, false);
      const mcpPost = posted.find((p) => p.body.event === "$mcp_tool_call");
      assert.ok(mcpPost, "$mcp_tool_call should be posted");
      assert.equal(mcpPost.body.properties.$mcp_tool_name, TOOL);
      assert.equal(mcpPost.body.properties.$mcp_is_error, false);
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
      // Two events: usage_event + $mcp_tool_call.
      assert.equal(posted.length, 2);
      const usagePost = posted.find((p) => p.body.event === "usage_event");
      assert.ok(usagePost, "usage_event should be posted");
      assert.equal(usagePost.body.properties.ok, false);
      assert.equal(usagePost.body.properties.error_code, "invalid_params");
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

  // #7737: proves the redaction end-to-end through the real dispatch path
  // (callTool -> scheduleMcpToolCallEvent -> recordMcpToolCallEvent -> fetch),
  // not just against the unit-level function in usage-telemetry.test.mjs.
  test("$mcp_tool_call never leaks call_subnet_surface's credential argument", async () => {
    const original = globalThis.fetch;
    const posted = [];
    globalThis.fetch = async (url, init) => {
      posted.push({ url, body: JSON.parse(init.body) });
      return { ok: true };
    };
    try {
      const executionCtx = fakeExecutionCtx();
      await callMcp(
        toolCall("call_subnet_surface", {
          surface_id: "x:api:6",
          credential: "Bearer super-secret-abc123",
        }),
        CONFIGURED_ENV,
        { executionCtx },
      );
      await Promise.all(executionCtx.scheduled);

      assert.ok(!JSON.stringify(posted).includes("super-secret-abc123"));
      const mcpPost = posted.find((p) => p.body.event === "$mcp_tool_call");
      assert.ok(mcpPost, "$mcp_tool_call should be posted");
      assert.equal(
        mcpPost.body.properties.$mcp_parameters.credential,
        "[redacted]",
      );
      assert.equal(
        mcpPost.body.properties.$mcp_parameters.surface_id,
        "x:api:6",
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  test("$mcp_tool_call never leaks get_alert_trigger's owner_token argument", async () => {
    const original = globalThis.fetch;
    const posted = [];
    globalThis.fetch = async (url, init) => {
      posted.push({ url, body: JSON.parse(init.body) });
      return { ok: true };
    };
    try {
      const executionCtx = fakeExecutionCtx();
      const payload = await callMcp(
        toolCall("get_alert_trigger", {
          id: "trigger-1",
          owner_token: "owner-secret-xyz",
        }),
        CONFIGURED_ENV,
        { executionCtx },
      );
      await Promise.all(executionCtx.scheduled);

      // DATA_API isn't bound in tests -- the tool call itself fails, but the
      // argument capture in callTool doesn't depend on the tool succeeding.
      assert.equal(payload.result.isError, true);
      assert.ok(!JSON.stringify(posted).includes("owner-secret-xyz"));
      const mcpPost = posted.find((p) => p.body.event === "$mcp_tool_call");
      assert.ok(mcpPost, "$mcp_tool_call should be posted");
      assert.equal(
        mcpPost.body.properties.$mcp_parameters.owner_token,
        "[redacted]",
      );
      assert.equal(mcpPost.body.properties.$mcp_parameters.id, "trigger-1");
    } finally {
      globalThis.fetch = original;
    }
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
        recordMcpToolCallEvent: async () => false,
        executionCtx: {
          waitUntil() {
            throw new Error("isolate already finished");
          },
        },
      },
      "no ExecutionContext at all": {
        recordUsageEvent: recorder().recordUsageEvent,
        recordMcpToolCallEvent: async () => false,
      },
      // #7737: scheduleMcpToolCallEvent's own .catch(() => false) -- proves a
      // rejecting/throwing $mcp_tool_call recorder is exactly as harmless as
      // a rejecting/throwing usage_event recorder above.
      "$mcp_tool_call recorder rejects": {
        recordMcpToolCallEvent: () => Promise.reject(new Error("posthog down")),
        executionCtx: fakeExecutionCtx(),
      },
      "$mcp_tool_call recorder throws synchronously": {
        recordMcpToolCallEvent: () => {
          throw new Error("recorder exploded");
        },
        executionCtx: fakeExecutionCtx(),
      },
    };

    for (const [mode, deps] of Object.entries(failureModes)) {
      const payload = await callMcp(toolCall(TOOL), CONFIGURED_ENV, deps);
      // Flush the fire-and-forget telemetry promises before moving on, so a
      // rejecting recorder's own .catch(() => false) actually runs within
      // this test rather than resolving after it (both are equally safe --
      // this just makes the assertion below deterministic instead of racy).
      if (Array.isArray(deps.executionCtx?.scheduled)) {
        await Promise.allSettled(deps.executionCtx.scheduled);
      }
      assert.deepEqual(
        payload,
        baseline,
        `telemetry mode changed the result: ${mode}`,
      );
    }
  });

  // Mirrors the test above but for scheduleMcpInitializeEvent's own
  // .catch(() => false) -- initialize is the only method that fires it.
  test("an $mcp_initialize telemetry failure changes nothing about the initialize result", async () => {
    const initializeRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    };
    const baseline = await callMcp(initializeRequest, {});
    assert.equal(baseline.result.protocolVersion, "2025-03-26");

    const failureModes = {
      "recorder rejects": {
        recordMcpInitializeEvent: () =>
          Promise.reject(new Error("posthog down")),
        executionCtx: fakeExecutionCtx(),
      },
      "recorder throws synchronously": {
        recordMcpInitializeEvent: () => {
          throw new Error("recorder exploded");
        },
        executionCtx: fakeExecutionCtx(),
      },
    };

    for (const [mode, deps] of Object.entries(failureModes)) {
      const payload = await callMcp(initializeRequest, CONFIGURED_ENV, deps);
      if (Array.isArray(deps.executionCtx?.scheduled)) {
        await Promise.allSettled(deps.executionCtx.scheduled);
      }
      assert.deepEqual(
        payload,
        baseline,
        `telemetry mode changed the result: ${mode}`,
      );
    }
  });
});
