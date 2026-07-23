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
    assert.equal(executionCtx.scheduled.length, 1);
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
    // #7726: the unknown-tool branch carries its own stable code, in both the
    // structuredContent contract and the usage event.
    assert.equal(payload.result.structuredContent.error.code, "unknown_tool");
    assert.equal(spy.events[0].event.errorCode, "unknown_tool");
  });

  test("records a failing tool as a failure", async () => {
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
    // #7726: the toolError's categorized code is threaded into the event,
    // matching the machine-readable structuredContent contract exactly.
    assert.equal(
      spy.events[0].event.errorCode,
      payload.result.structuredContent.error.code,
    );
    assert.equal(spy.events[0].event.errorCode, "invalid_params");
  });

  test("a successful call carries no errorCode at all (#7726)", async () => {
    const spy = recorder();
    const payload = await callMcp(toolCall(TOOL), CONFIGURED_ENV, {
      executionCtx: fakeExecutionCtx(),
      recordUsageEvent: spy.recordUsageEvent,
    });

    assert.equal(payload.result.isError, false);
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
      assert.equal(posted.length, 1);
      assert.equal(posted[0].body.event, "usage_event");
      assert.equal(posted[0].body.properties.mcp_tool, TOOL);
      assert.equal(posted[0].body.properties.ok, true);
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
