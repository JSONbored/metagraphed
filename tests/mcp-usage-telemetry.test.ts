import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  POSTHOG_EXCEPTION_STORM_WINDOW_MS_ENV,
  POSTHOG_PROJECT_TOKEN_ENV,
  USAGE_EVENT_DISTINCT_ID,
  admitMcpRefusalCapture,
} from "../src/usage-telemetry.ts";
import {
  handleMcpRequest,
  listToolDefinitions,
  mcpDistinctId,
  mcpRefusalReason,
  scheduleMcpRefusalEvent,
  splitMcpIntent,
  withIntentArgument,
} from "../src/mcp-server.ts";
import type { Row } from "./row-type.ts";

const CONFIGURED_ENV = { [POSTHOG_PROJECT_TOKEN_ENV]: "phc_test_token" };
const TOOL = "get_contracts";

// Collects what each tools/call hands the recorder, plus what it hands
// waitUntil, without going anywhere near PostHog.
function recorder({ result = true as boolean | (() => unknown) } = {}) {
  const events: Row[] = [];
  return {
    events,
    recordUsageEvent(env: unknown, event: unknown) {
      events.push({ env, event });
      return typeof result === "function" ? result() : result;
    },
  };
}

function fakeExecutionCtx() {
  const scheduled: Promise<unknown>[] = [];
  return {
    scheduled,
    waitUntil: (promise: Promise<unknown>) => scheduled.push(promise),
  };
}

function makeDeps(extra = {}) {
  return {
    readArtifact: (_env: Row, path: string) =>
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

function toolCall(name: string, args: Row = {}) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  };
}

async function callMcp(
  body: unknown,
  env: Row,
  extraDeps: Row = {},
): Promise<Row> {
  const request = new Request("https://api.metagraph.sh/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
  const response = await handleMcpRequest(
    request,
    env as unknown as Env,
    makeDeps(extraDeps),
  );
  return (await response.json()) as Row;
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

  // #8993 CHANGED THIS DELIBERATELY. This used to assert tools/list recorded
  // NOTHING, which was true and was the bug: 9 of 14 dispatch cases were
  // silent, so "MCP usage" meant "tool calls" and nothing else. tools/list now
  // records like every other protocol method.
  //
  // What must stay true is the distinction the original test was reaching for:
  // a protocol event is not a TOOL event. It carries `route`, never `mcpTool`,
  // so the tool-call count is unchanged by this.
  test("records tools/list as a protocol event, not a tool invocation", async () => {
    const spy = recorder();
    await callMcp(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      CONFIGURED_ENV,
      {
        executionCtx: fakeExecutionCtx(),
        recordUsageEvent: spy.recordUsageEvent,
      },
    );

    assert.equal(spy.events.length, 1);
    const event = spy.events[0].event as Row;
    assert.equal(event.route, "mcp:tools/list");
    assert.equal(event.mcpTool, undefined);
  });

  test("falls back to the real recorder when none is injected", async () => {
    // Exercises the default path end-to-end: no injected recorder, so the
    // module's own recordUsageEvent runs and posts through the platform fetch.
    const original = globalThis.fetch;
    const posted: Row[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      posted.push({ url, body: JSON.parse(init!.body as string) });
      return { ok: true };
    }) as typeof fetch;
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
    const posted: Row[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      posted.push({ url, body: JSON.parse(init!.body as string) });
      return { ok: true };
    }) as typeof fetch;
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
  // not just against the unit-level function in usage-telemetry.test.ts.
  test("$mcp_tool_call never leaks call_subnet_surface's credential argument", async () => {
    const original = globalThis.fetch;
    const posted: Row[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      posted.push({ url, body: JSON.parse(init!.body as string) });
      return { ok: true };
    }) as typeof fetch;
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
    const posted: Row[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      posted.push({ url, body: JSON.parse(init!.body as string) });
      return { ok: true };
    }) as typeof fetch;
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

    const failureModes: Record<string, Row> = {
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

// metagraphed#7153: real per-caller identity. @cloudflare/workers-oauth-provider
// stamps `ctx.props` on the ExecutionContext once it has validated the
// caller's Bearer token (src/github-oauth.ts) -- buildContext resolves that
// into a namespaced PostHog distinct_id, threaded through every telemetry
// event this dispatch path emits.
describe("MCP telemetry distinct_id resolution (#7153)", () => {
  function fakeExecutionCtxWithProps(props?: Row) {
    const scheduled: Promise<unknown>[] = [];
    return {
      scheduled,
      waitUntil: (promise: Promise<unknown>) => scheduled.push(promise),
      ...(props !== undefined ? { props } : {}),
    };
  }

  test("an authenticated caller's events carry distinct_id github:<login>", async () => {
    const original = globalThis.fetch;
    const posted: Row[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      posted.push({ url, body: JSON.parse(init!.body as string) });
      return { ok: true };
    }) as typeof fetch;
    try {
      const executionCtx = fakeExecutionCtxWithProps({
        githubUserId: 12345,
        githubLogin: "octocat",
      });
      const payload = await callMcp(toolCall(TOOL), CONFIGURED_ENV, {
        executionCtx,
      });
      await Promise.all(executionCtx.scheduled);

      assert.equal(payload.result.isError, false);
      assert.equal(posted.length, 2);
      for (const post of posted) {
        assert.equal(post.body.distinct_id, "github:octocat");
      }
    } finally {
      globalThis.fetch = original;
    }
  });

  test("an anonymous caller (no executionCtx.props) still falls back to the shared distinct_id", async () => {
    const original = globalThis.fetch;
    const posted: Row[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      posted.push({ url, body: JSON.parse(init!.body as string) });
      return { ok: true };
    }) as typeof fetch;
    try {
      const executionCtx = fakeExecutionCtxWithProps();
      const payload = await callMcp(toolCall(TOOL), CONFIGURED_ENV, {
        executionCtx,
      });
      await Promise.all(executionCtx.scheduled);

      assert.equal(payload.result.isError, false);
      assert.equal(posted.length, 2);
      for (const post of posted) {
        assert.equal(post.body.distinct_id, USAGE_EVENT_DISTINCT_ID);
      }
    } finally {
      globalThis.fetch = original;
    }
  });

  test("a malformed (non-string) githubLogin is treated as anonymous, not a crash", async () => {
    const original = globalThis.fetch;
    const posted: Row[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      posted.push({ url, body: JSON.parse(init!.body as string) });
      return { ok: true };
    }) as typeof fetch;
    try {
      const executionCtx = fakeExecutionCtxWithProps({ githubLogin: 12345 });
      const payload = await callMcp(toolCall(TOOL), CONFIGURED_ENV, {
        executionCtx,
      });
      await Promise.all(executionCtx.scheduled);

      assert.equal(payload.result.isError, false);
      const usagePost = posted.find((p) => p.body.event === "usage_event");
      assert.ok(usagePost);
      assert.equal(usagePost.body.distinct_id, USAGE_EVENT_DISTINCT_ID);
    } finally {
      globalThis.fetch = original;
    }
  });

  // Proves the full chain end-to-end: executionCtx.props -> buildContext's
  // McpCtx.distinctId -> the ask tool handler -> askQuestion's AskDeps ->
  // recordAiGenerationEvent -- not just the usage_event/$mcp_tool_call
  // schedulers covered above, which don't exercise the ask tool's own
  // separate distinctId passthrough (src/mcp-server.ts's ask handler,
  // src/ai-search.ts's askQuestion).
  test("the ask tool attributes its $ai_generation event to the same resolved identity", async () => {
    const original = globalThis.fetch;
    const posted: Row[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      posted.push({ url, body: JSON.parse(init!.body as string) });
      return { ok: true };
    }) as typeof fetch;
    try {
      const executionCtx = fakeExecutionCtxWithProps({
        githubLogin: "octocat",
      });
      const env = {
        ...CONFIGURED_ENV,
        METAGRAPH_ENABLE_AI: "true",
        AI: {
          run(_model: unknown, input: Row) {
            if (input?.text) {
              const n = Array.isArray(input.text) ? input.text.length : 1;
              return Promise.resolve({
                data: Array.from({ length: n }, () =>
                  new Array(1024).fill(0.02),
                ),
              });
            }
            return Promise.resolve({ response: "answer." });
          },
        },
        VECTORIZE: { query: () => Promise.resolve({ matches: [] }) },
      };
      const payload = await callMcp(
        toolCall("ask", { question: "which subnet does images?" }),
        env,
        { executionCtx },
      );
      await Promise.all(executionCtx.scheduled);

      assert.equal(payload.result.isError, false);
      const aiPost = posted.find((p) => p.body.event === "$ai_generation");
      assert.ok(aiPost, "$ai_generation should be posted");
      assert.equal(aiPost.body.distinct_id, "github:octocat");
    } finally {
      globalThis.fetch = original;
    }
  });
});

// metagraphed#7758: dispatchTool's PostHog $exception capture, parallel-run
// alongside the existing Sentry.captureException at the same site. Uses the
// same real internal-error trigger as
// tests/mcp-server-branch-coverage.test.ts's "semantic_search wraps a
// Vectorize rejection as an internal error" -- a genuine unexpected fault,
// not a toolError, so it's the one path that reaches dispatchTool's catch.
describe("MCP dispatchTool exception capture ($exception)", () => {
  function aiEnv(overrides = {}) {
    return {
      ...CONFIGURED_ENV,
      METAGRAPH_ENABLE_AI: "true",
      AI: {
        run(_model: unknown, input: Row) {
          if (input?.text) {
            const n = Array.isArray(input.text) ? input.text.length : 1;
            return Promise.resolve({
              data: Array.from({ length: n }, () => new Array(1024).fill(0.02)),
            });
          }
          return Promise.resolve({ response: "answer." });
        },
      },
      VECTORIZE: {
        query: () => Promise.reject(new Error("vectorize exploded")),
      },
      ...overrides,
    };
  }

  test("an unexpected internal fault posts a $exception event tagged with the tool name", async () => {
    const original = globalThis.fetch;
    const posted: Row[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      posted.push({ url, body: JSON.parse(init!.body as string) });
      return { ok: true };
    }) as typeof fetch;
    try {
      const executionCtx = fakeExecutionCtx();
      const payload = await callMcp(
        toolCall("semantic_search", { query: "images" }),
        aiEnv(),
        { executionCtx },
      );
      await Promise.all(executionCtx.scheduled);

      assert.equal(payload.result.isError, true);
      assert.equal(
        payload.result.structuredContent.error.code,
        "internal_error",
      );
      // The PUBLIC tool response stays sanitized (no internal message) --
      // already covered by tests/mcp-server-branch-coverage.test.ts. The
      // PRIVATE $exception payload sent to PostHog is a different channel:
      // it's SUPPOSED to carry the real error, that's the point of error
      // tracking.
      const exceptionPost = posted.find((p) => p.body.event === "$exception");
      assert.ok(exceptionPost, "$exception should be posted");
      assert.equal(exceptionPost.body.properties.mcp_tool, "semantic_search");
      assert.equal(exceptionPost.body.properties.error_code, "internal_error");
      assert.equal(
        exceptionPost.body.properties.$exception_list[0].value,
        "vectorize exploded",
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  test("an expected toolError (invalid_params) never posts a $exception event", async () => {
    const original = globalThis.fetch;
    const posted: Row[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      posted.push({ url, body: JSON.parse(init!.body as string) });
      return { ok: true };
    }) as typeof fetch;
    try {
      const executionCtx = fakeExecutionCtx();
      await callMcp(
        toolCall("get_subnet", { netuid: "not-a-netuid" }),
        CONFIGURED_ENV,
        { executionCtx },
      );
      await Promise.all(executionCtx.scheduled);

      assert.equal(
        posted.some((p) => p.body.event === "$exception"),
        false,
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  // Mirrors the usage_event/$mcp_tool_call/$mcp_initialize failure-mode tests
  // above -- scheduleExceptionEvent's own .catch(() => false), now actually
  // reachable via injection since buildContext threads recordExceptionEvent
  // through (fixed alongside #7153; it previously only copied
  // recordUsageEvent onto ctx, so this exact injection silently no-opped).
  test("an $exception telemetry failure changes nothing about the tool result", async () => {
    const baseline = await callMcp(
      toolCall("semantic_search", { query: "images" }),
      aiEnv(),
    );
    assert.equal(baseline.result.isError, true);

    const failureModes: Record<string, Row> = {
      "recorder rejects": {
        recordExceptionEvent: () => Promise.reject(new Error("posthog down")),
        executionCtx: fakeExecutionCtx(),
      },
      "recorder throws synchronously": {
        recordExceptionEvent: () => {
          throw new Error("recorder exploded");
        },
        executionCtx: fakeExecutionCtx(),
      },
    };

    for (const [mode, deps] of Object.entries(failureModes)) {
      const payload = await callMcp(
        toolCall("semantic_search", { query: "images" }),
        aiEnv(),
        deps,
      );
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

// #8999: find_subnet_for_task falls back from semantic to keyword search on any
// AI failure. Falling back is correct; falling back SILENTLY was not — the agent
// asked for semantic matching on intent and got keyword matching, with nothing
// in the response saying so. recordAiDegradedEvent already existed and was
// already used for the rate-limited case in src/ai-search.ts; the largest
// consumer of semantic search simply never called it.
describe("MCP semantic-search degradation (ai_degraded)", () => {
  function degradedRecorder() {
    const events: Row[] = [];
    return {
      events,
      recordAiDegradedEvent(env: unknown, event: unknown) {
        events.push({ env, event });
        return true;
      },
    };
  }

  // AI enabled, and the vector query rejects — the outage shape.
  const brokenAiEnv = () => ({
    ...CONFIGURED_ENV,
    METAGRAPH_ENABLE_AI: "true",
    AI: {
      run: () =>
        Promise.resolve({ data: [new Array(1024).fill(0.02)] }) as Promise<Row>,
    },
    VECTORIZE: { query: () => Promise.reject(new Error("vectorize exploded")) },
  });

  test("emits ai_degraded when semantic search fails", async () => {
    const spy = degradedRecorder();
    await callMcp(
      toolCall("find_subnet_for_task", { task: "summarize a document" }),
      brokenAiEnv(),
      {
        executionCtx: fakeExecutionCtx(),
        recordAiDegradedEvent: spy.recordAiDegradedEvent,
      },
    );

    assert.equal(spy.events.length, 1);
    const event = spy.events[0].event as Row;
    assert.equal(event.reason, "semantic_search_failed");
    // Surface names the caller, so an MCP-originated degradation is separable
    // from the REST /api/v1/ask path that shares the underlying helper.
    assert.equal(event.surface, "find_subnet_for_task");
  });

  // The tool must still answer. A degradation event that came with a broken
  // response would just be a worse error.
  test("the tool still returns a keyword-mode answer", async () => {
    const payload = await callMcp(
      toolCall("find_subnet_for_task", { task: "summarize a document" }),
      brokenAiEnv(),
      {
        executionCtx: fakeExecutionCtx(),
        recordAiDegradedEvent: () => true,
      },
    );
    assert.equal(payload.result.isError, false);
  });

  // No degradation when AI is off: that is a configuration, not a fault, and
  // emitting for it would make the signal meaningless on the deployments where
  // keyword search is simply the intended mode.
  test("does not emit when AI is disabled", async () => {
    const spy = degradedRecorder();
    await callMcp(
      toolCall("find_subnet_for_task", { task: "summarize a document" }),
      CONFIGURED_ENV,
      {
        executionCtx: fakeExecutionCtx(),
        recordAiDegradedEvent: spy.recordAiDegradedEvent,
      },
    );
    assert.deepEqual(spy.events, []);
  });

  test("a recorder that throws never surfaces into the tool result", async () => {
    const payload = await callMcp(
      toolCall("find_subnet_for_task", { task: "summarize a document" }),
      brokenAiEnv(),
      {
        executionCtx: fakeExecutionCtx(),
        recordAiDegradedEvent: () => {
          throw new Error("recorder exploded");
        },
      },
    );
    assert.equal(payload.result.isError, false);
  });
});

// #8993: 9 of the 14 cases in dispatchMessage's switch emitted NOTHING — every
// resources/* method (including resources/subscribe, which MCP_CAPABILITIES
// advertises), both prompts/*, ping, both notifications/*, and the
// unknown-method default. Only initialize, tools/list and tools/call were
// visible, so "MCP usage" really meant "tool calls" and whether agents read
// resources at all was unanswerable.
describe("MCP protocol-method usage telemetry", () => {
  const rpcCall = (method: string, params?: Row) => ({
    jsonrpc: "2.0",
    id: 1,
    method,
    ...(params ? { params } : {}),
  });

  async function eventsFor(method: string, params?: Row, env = CONFIGURED_ENV) {
    const spy = recorder();
    await callMcp(rpcCall(method, params), env, {
      executionCtx: fakeExecutionCtx(),
      recordUsageEvent: spy.recordUsageEvent,
    });
    return spy.events.map((e) => e.event as Row);
  }

  test("every previously-silent protocol method now emits one event", async () => {
    for (const method of [
      "ping",
      "resources/list",
      "resources/templates/list",
      "prompts/list",
    ]) {
      const events = await eventsFor(method);
      assert.equal(events.length, 1, `${method} emitted ${events.length}`);
      assert.equal(events[0].route, `mcp:${method}`);
      assert.equal(events[0].ok, true);
      assert.equal(typeof events[0].durationMs, "number");
    }
  });

  // The one method that already had its own usage_event. Emitting here too
  // would double-count every tool call in the project's headline number.
  test("tools/call is NOT double-counted", async () => {
    const events = await eventsFor("tools/call", {
      name: TOOL,
      arguments: {},
    });
    assert.equal(events.length, 1);
    // The surviving event is the tool one (keyed by tool), not a protocol one.
    assert.equal(events[0].mcpTool, TOOL);
    assert.equal(events[0].route, undefined);
  });

  // An unknown method returns rpcError WITHOUT throwing, so timing alone would
  // have recorded it as a success.
  test("an unknown method is recorded as a failure", async () => {
    const events = await eventsFor("totally/made/up");
    assert.equal(events.length, 1);
    assert.equal(events[0].ok, false);
  });

  // `method` is caller-supplied. Labelling it verbatim would mint a new route
  // per request — the unbounded-cardinality defect #9001 removed elsewhere.
  test("unknown methods collapse to one label rather than minting one each", async () => {
    const a = await eventsFor("totally/made/up");
    const b = await eventsFor("something/else/entirely");
    assert.equal(a[0].route, "mcp:unknown");
    assert.equal(b[0].route, "mcp:unknown");
  });

  // A notification has no response to inspect -- 202, empty body -- so
  // server-side telemetry is the ONLY way it can ever be observed. callMcp
  // parses JSON, so this drives handleMcpRequest directly.
  test("a notification emits too, despite returning no response", async () => {
    const spy = recorder();
    const request = new Request("https://api.metagraph.sh/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    });
    const response = await handleMcpRequest(
      request,
      CONFIGURED_ENV as unknown as Env,
      makeDeps({
        executionCtx: fakeExecutionCtx(),
        recordUsageEvent: spy.recordUsageEvent,
      }),
    );
    assert.equal(response.status, 202);
    const events = spy.events.map((e) => e.event as Row);
    assert.equal(events.length, 1);
    assert.equal(events[0].route, "mcp:notifications/initialized");
  });

  test("the caller's client and auth tier ride along", async () => {
    const spy = recorder();
    const request = new Request("https://api.metagraph.sh/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "claude-code/2.1.220",
      },
      body: JSON.stringify(rpcCall("ping")),
    });
    await handleMcpRequest(
      request,
      CONFIGURED_ENV as unknown as Env,
      makeDeps({
        executionCtx: fakeExecutionCtx(),
        recordUsageEvent: spy.recordUsageEvent,
      }),
    );
    const event = spy.events[0].event as Row;
    assert.equal(event.client, "claude-code");
    // No credential was presented, so the tier is the explicit "anonymous"
    // (ADR 0027) rather than an omission.
    assert.equal(event.authTier, "anonymous");
  });

  test("telemetry never changes the protocol response", async () => {
    const withSpy = await callMcp(rpcCall("prompts/list"), CONFIGURED_ENV, {
      executionCtx: fakeExecutionCtx(),
      recordUsageEvent: () => {
        throw new Error("recorder exploded");
      },
    });
    const without = await callMcp(rpcCall("prompts/list"), {});
    assert.deepEqual(withSpy, without);
  });
});

// #8994: $mcp_initialize was emitted with `sessionId: ctx.sessionId`, which
// reads the INBOUND Mcp-Session-Id header — and a client performing the
// canonical initialize has none to send, because obtaining one is the point of
// the call. So the property was null on every canonical initialize, and
// $mcp_initialize could not be joined to the $mcp_tool_call events of the same
// session: we had the child rows and no parent.
describe("MCP initialize session id (#8994)", () => {
  function initRecorder() {
    const events: Row[] = [];
    return {
      events,
      recordMcpInitializeEvent(env: unknown, event: unknown) {
        events.push({ env, event });
        return true;
      },
    };
  }

  async function initialize(clientInfo: Row | undefined, headers: Row = {}) {
    const spy = initRecorder();
    const request = new Request("https://api.metagraph.sh/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          ...(clientInfo ? { clientInfo } : {}),
        },
      }),
    });
    const response = await handleMcpRequest(
      request,
      CONFIGURED_ENV as unknown as Env,
      makeDeps({
        executionCtx: fakeExecutionCtx(),
        recordMcpInitializeEvent: spy.recordMcpInitializeEvent,
      }),
    );
    return { response, event: spy.events[0]?.event as Row };
  }

  // The whole point: the id on the event is the SAME one handed back in the
  // header, so the parent row joins to its children.
  test("the event carries the session id the response mints", async () => {
    const { response, event } = await initialize({
      name: "claude-code",
      version: "2.1.220",
    });
    const header = response.headers.get("mcp-session-id");
    assert.ok(header, "initialize must mint a session header");
    assert.equal(event.sessionId, header);
  });

  test("clientInfo is still authoritative when the client sends it", async () => {
    const { event } = await initialize({
      name: "claude-code",
      version: "2.1.220",
    });
    assert.equal(event.clientName, "claude-code");
    assert.equal(event.clientNameSource, "client_info");
  });

  // initialize was the ONE $mcp_* event not spreading mcpAttributionFor, so a
  // client omitting clientInfo produced an event with server attribution only —
  // even though ctx.clientName had already been parsed two lines away.
  test("falls back to the User-Agent, labelled as such", async () => {
    const { event } = await initialize(undefined, {
      "user-agent": "mcporter/0.12.3",
    });
    assert.equal(event.clientName, "mcporter");
    // Never client_info: a transport-level guess must not be recorded as an
    // MCP-declared identity.
    assert.equal(event.clientNameSource, "user_agent");
  });

  // A failed initialize must not leak a session id the client was never given.
  test("a non-initialize method mints nothing", async () => {
    const spy = initRecorder();
    const response = await handleMcpRequest(
      new Request("https://api.metagraph.sh/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }),
      CONFIGURED_ENV as unknown as Env,
      makeDeps({
        executionCtx: fakeExecutionCtx(),
        recordMcpInitializeEvent: spy.recordMcpInitializeEvent,
      }),
    );
    assert.equal(response.headers.get("mcp-session-id"), null);
    assert.equal(spy.events.length, 0);
  });
});

// #9054: every anonymous caller previously collapsed onto ONE distinct_id --
// 13,193 of 13,365 tool calls in a 14-day window shared the anonymous fallback
// constant, so no per-caller figure from the analytics project meant anything.
// The Streamable HTTP session id is already on the wire on ~77% of calls, so
// keying on it recovers most of that attribution without collecting anything
// new. These tests assert the identity that actually reaches PostHog, at the
// fetch boundary, rather than the intermediate ctx field.
describe("MCP caller attribution (#9054)", () => {
  async function postedEvents(
    body: unknown,
    headers: Row = {},
    deps: Row = {},
  ) {
    const original = globalThis.fetch;
    const posted: Row[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      posted.push(JSON.parse(init!.body as string));
      return { ok: true };
    }) as typeof fetch;
    const executionCtx = fakeExecutionCtx();
    try {
      await handleMcpRequest(
        new Request("https://api.metagraph.sh/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...headers,
          },
          body: JSON.stringify(body),
        }),
        CONFIGURED_ENV as never,
        makeDeps({ executionCtx, ...deps }),
      );
      await Promise.all(executionCtx.scheduled);
    } finally {
      globalThis.fetch = original;
    }
    return posted;
  }

  const SESSION = "3f1c2b90-0a4d-4c7e-9a11-2b7d6e5f4c31";

  test("a session-carrying call is attributed to its session, not the shared constant", async () => {
    const posted = await postedEvents(toolCall(TOOL), {
      "mcp-session-id": SESSION,
    });
    const call = posted.find((p) => p.event === "$mcp_tool_call");
    assert.ok(call, "$mcp_tool_call should be posted");
    assert.equal(call.distinct_id, `mcp-session:${SESSION}`);
    assert.notEqual(call.distinct_id, USAGE_EVENT_DISTINCT_ID);
  });

  // The 23% with no session must still be recorded — losing the event would be
  // a worse outcome than an uncountable one.
  test("a sessionless call still records, on the anonymous constant", async () => {
    const posted = await postedEvents(toolCall(TOOL));
    const call = posted.find((p) => p.event === "$mcp_tool_call");
    assert.ok(call);
    assert.equal(call.distinct_id, USAGE_EVENT_DISTINCT_ID);
  });

  // A canonical initialize carries no inbound session — obtaining one is the
  // point of the call — so without this it lands on the anonymous constant and
  // the handshake can never be joined to the tool calls it precedes.
  test("initialize is attributed to the session it creates", async () => {
    const posted = await postedEvents({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    const init = posted.find((p) => p.event === "$mcp_initialize");
    assert.ok(init, "$mcp_initialize should be posted");
    assert.match(init.distinct_id, /^mcp-session:/);
    // The identity must be the session the response actually hands back, or
    // the handshake and the calls that follow it land on different ids.
    assert.equal(
      init.distinct_id,
      `mcp-session:${init.properties.$session_id}`,
    );
  });

  test("a GitHub identity outranks the session", async () => {
    const posted = await postedEvents(
      toolCall(TOOL),
      { "mcp-session-id": SESSION },
      {
        executionCtx: {
          ...fakeExecutionCtx(),
          props: { githubLogin: "octocat" },
        },
      },
    );
    const call = posted.find((p) => p.event === "$mcp_tool_call");
    assert.ok(call);
    assert.equal(call.distinct_id, "github:octocat");
  });

  // A malformed header is not an identity. Accepting it would let a caller
  // mint arbitrary distinct_ids, including ones shaped like another namespace.
  test("a malformed session header is not treated as an identity", async () => {
    const posted = await postedEvents(toolCall(TOOL), {
      "mcp-session-id": "not a valid session id",
    });
    const call = posted.find((p) => p.event === "$mcp_tool_call");
    assert.ok(call);
    assert.equal(call.distinct_id, USAGE_EVENT_DISTINCT_ID);
  });
});

// The resolver in isolation. The end-to-end tests above prove the wiring; this
// pins the precedence and the namespacing rule, which is the part a future
// identity system has to respect.
describe("mcpDistinctId precedence (#9054)", () => {
  test("GitHub beats session beats nothing", () => {
    assert.equal(mcpDistinctId("octocat", "s1"), "github:octocat");
    assert.equal(mcpDistinctId(undefined, "s1"), "mcp-session:s1");
    assert.equal(mcpDistinctId(undefined, null), undefined);
    assert.equal(mcpDistinctId(undefined, undefined), undefined);
  });

  test("a non-string or empty login is not an identity", () => {
    assert.equal(mcpDistinctId("", "s1"), "mcp-session:s1");
    assert.equal(mcpDistinctId(42, "s1"), "mcp-session:s1");
    assert.equal(mcpDistinctId(null, "s1"), "mcp-session:s1");
    assert.equal(mcpDistinctId({}, null), undefined);
  });

  test("an empty session is not an identity", () => {
    assert.equal(mcpDistinctId(undefined, ""), undefined);
  });

  // A session id may legally contain a colon (isValidMcpSessionId allows any
  // printable ASCII), so without the prefix a caller could send
  // `github:someone` as their session and mint a GitHub-namespaced identity.
  test("namespacing stops a session id from impersonating another namespace", () => {
    assert.equal(
      mcpDistinctId(undefined, "github:someone"),
      "mcp-session:github:someone",
    );
    assert.notEqual(
      mcpDistinctId(undefined, "github:someone"),
      "github:someone",
    );
  });
});

// #9639: every refusal that returns before dispatchMessage used to emit
// nothing. `/mcp` is excluded from withUsageTelemetry because the dispatch
// loop instruments itself (#8993), so a request refused ABOVE the loop fell
// between the two and a throttled or quota-exhausted client just stopped
// appearing.
describe("MCP pre-dispatch refusal telemetry (#9639)", () => {
  const refusalEvents = (spy: { events: Row[] }) =>
    spy.events.filter((e) =>
      String((e.event as Row)?.route ?? "").startsWith("mcp:refused:"),
    );

  test("a 405 refusal is recorded with its reason", async () => {
    const spy = recorder();
    const ctx = fakeExecutionCtx();
    const response = await handleMcpRequest(
      new Request("https://api.metagraph.sh/mcp", { method: "PUT" }),
      CONFIGURED_ENV as unknown as Env,
      makeDeps({
        recordUsageEvent: spy.recordUsageEvent,
        executionCtx: ctx,
      }),
    );
    // The response itself must be untouched by the instrumentation.
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET, POST, DELETE, OPTIONS");

    const events = refusalEvents(spy);
    assert.equal(events.length, 1);
    const event = events[0]!.event as Row;
    assert.equal(event.route, "mcp:refused:method_not_allowed");
    assert.equal(event.ok, false);
    assert.equal(event.status, 405);
    assert.equal(event.method, "PUT");
  });

  // The other half of the boundary rule: a DISPATCHED call must not be
  // counted as a refusal. Dispatch answers 2xx even when the JSON-RPC body
  // carries an error, which is exactly why `response.ok` is the discriminator.
  test("a dispatched tools/call records no refusal, even when it errors", async () => {
    const spy = recorder();
    const body = await callMcp(toolCall("definitely_not_a_real_tool"), {
      ...CONFIGURED_ENV,
    });
    assert.equal((body.result as Row)?.isError, true);
    assert.deepEqual(refusalEvents(spy), []);
  });

  test("a malformed JSON body is recorded as bad_request", async () => {
    const spy = recorder();
    const ctx = fakeExecutionCtx();
    const response = await handleMcpRequest(
      new Request("https://api.metagraph.sh/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
      CONFIGURED_ENV as unknown as Env,
      makeDeps({
        recordUsageEvent: spy.recordUsageEvent,
        executionCtx: ctx,
      }),
    );
    assert.equal(response.ok, false);
    const events = refusalEvents(spy);
    assert.equal(events.length, 1);
    assert.equal((events[0]!.event as Row).ok, false);
  });

  // The storm guard is the whole reason this is safe to unsample. A caller
  // hammering the same refusal must produce ONE event per window carrying the
  // suppressed count, not one per request.
  test("repeated identical refusals collapse into one event per window", async () => {
    const spy = recorder();
    // The window is env-gated and DISABLED when unset (the schema's
    // .positive().catch(0) sentinel), so it has to be configured here or this
    // test would assert the guard while measuring the disabled path.
    // Production sets 300000 in wrangler.jsonc.
    const env = {
      ...CONFIGURED_ENV,
      [POSTHOG_EXCEPTION_STORM_WINDOW_MS_ENV]: "300000",
    };
    const refuse = () =>
      handleMcpRequest(
        new Request("https://api.metagraph.sh/mcp", { method: "PUT" }),
        env as unknown as Env,
        makeDeps({
          recordUsageEvent: spy.recordUsageEvent,
          executionCtx: fakeExecutionCtx(),
        }),
      );
    for (let i = 0; i < 5; i += 1) await refuse();
    assert.equal(
      refusalEvents(spy).length,
      1,
      "five refusals, one event -- the rest are suppressed into its counter",
    );
  });

  // The counter itself, driven directly so the window boundary is exact
  // rather than wall-clock dependent.
  test("the guard reports how many it suppressed on the next admission", () => {
    const env = {
      [POSTHOG_EXCEPTION_STORM_WINDOW_MS_ENV]: "1000",
    } as unknown as Env;
    assert.equal(admitMcpRefusalCapture(env, "rate_limited", 0), 0);
    assert.equal(admitMcpRefusalCapture(env, "rate_limited", 10), null);
    assert.equal(admitMcpRefusalCapture(env, "rate_limited", 20), null);
    // Next window opens: the two held occurrences are reported, not lost.
    assert.equal(admitMcpRefusalCapture(env, "rate_limited", 1000), 2);
    // A DIFFERENT reason keeps its own window -- a rate-limit storm must not
    // silence the first daily-quota refusal.
    assert.equal(admitMcpRefusalCapture(env, "daily_quota", 20), 0);
  });

  test("an unset window disables the guard rather than blocking every event", () => {
    assert.equal(admitMcpRefusalCapture({} as unknown as Env, "x", 0), 0);
    assert.equal(admitMcpRefusalCapture({} as unknown as Env, "x", 1), 0);
  });

  // Telemetry must never surface into the MCP path: a recorder that throws
  // has to leave the refusal response exactly as it was.
  test("a throwing recorder cannot change the response", async () => {
    const response = await handleMcpRequest(
      new Request("https://api.metagraph.sh/mcp", { method: "PUT" }),
      CONFIGURED_ENV as unknown as Env,
      makeDeps({
        recordUsageEvent: () => {
          throw new Error("recorder exploded");
        },
        executionCtx: fakeExecutionCtx(),
      }),
    );
    assert.equal(response.status, 405);
  });

  // With no PostHog token the whole path is a no-op -- it must not throw and
  // must not attempt to record.
  test("an unconfigured environment records nothing and still refuses", async () => {
    const spy = recorder();
    const response = await handleMcpRequest(
      new Request("https://api.metagraph.sh/mcp", { method: "PUT" }),
      {} as unknown as Env,
      makeDeps({
        recordUsageEvent: spy.recordUsageEvent,
        executionCtx: fakeExecutionCtx(),
      }),
    );
    assert.equal(response.status, 405);
    assert.deepEqual(refusalEvents(spy), []);
  });
});

// The reason mapper, driven directly. Every arm is a distinct operational
// question, and only 405/400 are reachable by constructing a Request -- a 429
// needs a rate-limiter verdict and a 413 an oversized body, so asserting them
// through the HTTP path would test the gate rather than the mapping.
describe("mcpRefusalReason (#9639)", () => {
  const withScope = (status: number, scope?: string) =>
    new Response(null, {
      status,
      headers: scope ? { "x-ratelimit-scope": scope } : {},
    });

  test("429 splits on x-ratelimit-scope, the header #8608 added for this", () => {
    assert.equal(
      mcpRefusalReason(withScope(429, "daily-quota")),
      "daily_quota",
    );
    assert.equal(mcpRefusalReason(withScope(429, "blocked")), "blocked");
    assert.equal(
      mcpRefusalReason(withScope(429, "per-minute")),
      "rate_limited",
    );
    // A 429 with no scope header is still a refusal, not an unlabelled one.
    assert.equal(mcpRefusalReason(withScope(429)), "rate_limited");
  });

  test("each other refusal status maps to its own reason", () => {
    assert.equal(mcpRefusalReason(withScope(405)), "method_not_allowed");
    assert.equal(mcpRefusalReason(withScope(413)), "body_too_large");
    assert.equal(mcpRefusalReason(withScope(400)), "bad_request");
    assert.equal(mcpRefusalReason(withScope(401)), "unauthorized");
  });

  // The point of instrumenting at the boundary: a refusal added later is
  // counted without editing this mapper.
  test("an unmapped 4xx/5xx still gets a stable label", () => {
    assert.equal(mcpRefusalReason(withScope(418)), "status_418");
    assert.equal(mcpRefusalReason(withScope(503)), "status_503");
  });

  test("a non-error status is not a refusal", () => {
    assert.equal(mcpRefusalReason(withScope(302)), null);
    assert.equal(mcpRefusalReason(withScope(200)), null);
  });
});

describe("scheduleMcpRefusalEvent guards (#9639)", () => {
  const req = () =>
    new Request("https://api.metagraph.sh/mcp", { method: "POST" });

  test("a non-2xx the mapper does not recognise records nothing", () => {
    const spy = recorder();
    const ctx = fakeExecutionCtx();
    scheduleMcpRefusalEvent(
      req(),
      CONFIGURED_ENV as unknown as Env,
      { recordUsageEvent: spy.recordUsageEvent, executionCtx: ctx },
      new Response(null, { status: 302 }),
    );
    assert.deepEqual(spy.events, []);
  });

  test("a throttled reason is held back entirely", () => {
    const env = {
      ...CONFIGURED_ENV,
      [POSTHOG_EXCEPTION_STORM_WINDOW_MS_ENV]: "300000",
    } as unknown as Env;
    const spy = recorder();
    const fire = () =>
      scheduleMcpRefusalEvent(
        req(),
        env,
        {
          recordUsageEvent: spy.recordUsageEvent,
          executionCtx: fakeExecutionCtx(),
        },
        new Response(null, { status: 413 }),
      );
    fire();
    fire();
    fire();
    assert.equal(spy.events.length, 1);
  });

  // suppressed_occurrences rides on the NEXT admission, and is omitted rather
  // than sent as 0 when nothing was held -- a zero would read as a measured
  // quiet window instead of "first sighting".
  test("suppressed_occurrences is omitted on a clean window and present after a burst", () => {
    const spy = recorder();
    scheduleMcpRefusalEvent(
      req(),
      CONFIGURED_ENV as unknown as Env,
      {
        recordUsageEvent: spy.recordUsageEvent,
        executionCtx: fakeExecutionCtx(),
      },
      new Response(null, { status: 401 }),
    );
    const event = spy.events[0]!.event as Row;
    assert.equal(event.route, "mcp:refused:unauthorized");
    assert.equal("suppressed_occurrences" in event, false);
  });

  // The other side of that ternary: once a window rolls over, the count of
  // what was held is carried on the next event rather than discarded.
  //
  // Driven by an INJECTED clock, not a sleep. The first version of this test
  // used a 1ms window and a 20ms wait, and flaked roughly two runs in three:
  // the two calls meant to share a window straddled it whenever the event loop
  // scheduled them more than a millisecond apart. A throttle's boundary is
  // exactly the thing that has to be asserted deterministically.
  test("suppressed_occurrences rides the first event of the next window", () => {
    const env = {
      ...CONFIGURED_ENV,
      [POSTHOG_EXCEPTION_STORM_WINDOW_MS_ENV]: "1000",
    } as unknown as Env;
    const spy = recorder();
    const fire = (at: number) =>
      scheduleMcpRefusalEvent(
        req(),
        env,
        {
          recordUsageEvent: spy.recordUsageEvent,
          executionCtx: fakeExecutionCtx(),
        },
        new Response(null, { status: 418 }),
        at,
      );
    fire(0);
    fire(10);
    fire(20);
    fire(1000);
    assert.equal(spy.events.length, 2, "one per window, not one per call");
    const first = spy.events[0]!.event as Row;
    const second = spy.events[1]!.event as Row;
    assert.equal(first.route, "mcp:refused:status_418");
    assert.equal(
      "suppressed_occurrences" in first,
      false,
      "first sighting held nothing back",
    );
    assert.equal(second.suppressed_occurrences, 2);
  });

  test("a recorder that rejects is swallowed, never surfaced", async () => {
    const ctx = fakeExecutionCtx();
    scheduleMcpRefusalEvent(
      req(),
      CONFIGURED_ENV as unknown as Env,
      {
        recordUsageEvent: () => Promise.reject(new Error("posthog down")),
        executionCtx: ctx,
      },
      new Response(null, { status: 400 }),
    );
    // The scheduled promise must settle rather than reject -- an unhandled
    // rejection inside waitUntil is a Worker-level error.
    assert.equal(await ctx.scheduled[0], false);
  });

  test("falls back to the module recorder when deps supply none", () => {
    // No executionCtx either: the optional-chained waitUntil must not throw.
    assert.doesNotThrow(() =>
      scheduleMcpRefusalEvent(
        req(),
        CONFIGURED_ENV as unknown as Env,
        {},
        new Response(null, { status: 405 }),
      ),
    );
  });
});

// #9642: `context` is the argument an agent uses to say WHY it called, and
// PostHog's MCP Analytics records it as $mcp_intent. Until now the intent
// panel read "No agent intents captured yet" because nothing ever sent one.
describe("MCP agent intent capture (#9642)", () => {
  const tools = () => listToolDefinitions() as Row[];

  // Derived from listToolDefinitions() rather than a fixed list, so a tool
  // registered tomorrow is covered tonight -- the same bet the enum and
  // required gates in mcp-schema-enforcement.test.ts make.
  test("every published tool advertises the context argument", () => {
    const all = tools();
    assert.ok(
      all.length > 200,
      `expected the full catalogue, got ${all.length}`,
    );
    const missing = all
      .filter((t) => !(t.inputSchema as Row)?.properties?.context)
      .map((t) => t.name);
    assert.deepEqual(missing, [], "these tools cannot carry agent intent");
  });

  // THE COMPATIBILITY CONSTRAINT, pinned. PostHog's own SDK makes `context`
  // required; doing that here would reject every call from every existing
  // client on the next deploy, on all 224 tools at once. If someone ever
  // "fixes" this to match the SDK, this test is what says why not.
  test("context is optional on every tool -- never required", () => {
    const required = tools()
      .filter((t) =>
        (((t.inputSchema as Row)?.required as string[]) ?? []).includes(
          "context",
        ),
      )
      .map((t) => t.name);
    assert.deepEqual(
      required,
      [],
      "a required context would break every existing client",
    );
  });

  test("the advertised schema describes what to write", () => {
    const schema = (tools()[0]!.inputSchema as Row).properties.context as Row;
    assert.equal(schema.type, "string");
    assert.match(String(schema.description), /why are you calling this tool/i);
  });

  // The trap this feature had to avoid: advertised by tools/list but rejected
  // by validateToolArguments, which throws invalid_params for any key outside
  // `properties` (all 224 tools are additionalProperties:false). If the two
  // paths ever diverge again, this call starts failing.
  test("a call carrying context is accepted, not rejected as an unknown key", async () => {
    const payload = await callMcp(
      {
        ...toolCall(TOOL),
        params: { name: TOOL, arguments: { context: "why" } },
      },
      CONFIGURED_ENV,
      { executionCtx: fakeExecutionCtx() },
    );
    assert.equal((payload.result as Row).isError, false);
  });

  test("intent lands on $mcp_tool_call with its source, and not inside parameters", async () => {
    const events: Row[] = [];
    await callMcp(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "get_subnet",
          arguments: { netuid: 64, context: "Checking SN64 for a user report" },
        },
      },
      CONFIGURED_ENV,
      {
        executionCtx: fakeExecutionCtx(),
        recordMcpToolCallEvent: (_env: unknown, event: Row) => {
          events.push(event);
          return true;
        },
      },
    );
    assert.equal(events.length, 1);
    const event = events[0]!;
    assert.equal(event.intent, "Checking SN64 for a user report");
    // The real arguments survive; the intent is not duplicated among them.
    assert.deepEqual(event.parameters, { netuid: 64 });
  });

  test("the handler never receives context", () => {
    const { intent, rest } = splitMcpIntent({ netuid: 64, context: "why" });
    assert.equal(intent, "why");
    assert.deepEqual(rest, { netuid: 64 });
    assert.equal("context" in rest, false);
  });

  // "Did not explain" must stay distinguishable from "explained with nothing",
  // and a non-string is not an explanation.
  test("an empty, whitespace or non-string context yields no intent", () => {
    assert.equal(splitMcpIntent({ context: "" }).intent, undefined);
    assert.equal(splitMcpIntent({ context: "   " }).intent, undefined);
    assert.equal(splitMcpIntent({ context: 42 }).intent, undefined);
    assert.equal(splitMcpIntent({ context: null }).intent, undefined);
    // Still stripped from the arguments even when it is not usable as intent.
    assert.deepEqual(splitMcpIntent({ netuid: 1, context: 42 }).rest, {
      netuid: 1,
    });
  });

  // A schema that declares neither `type` nor `properties` is legal under
  // JsonSchemaLike (hand-written literals are still permitted) even though no
  // registered tool is shaped that way today. The fallbacks exist for that
  // tool; exercised here so they are known to work rather than assumed.
  test("a schema missing type/properties still gets a well-formed one", () => {
    const injected = withIntentArgument({
      name: "hypothetical",
      title: "Hypothetical",
      description: "d",
      inputSchema: {},
      handler: async () => ({}),
    });
    const schema = injected.inputSchema as Row;
    assert.equal(schema.type, "object");
    assert.deepEqual(Object.keys(schema.properties as Row), ["context"]);
  });

  test("an existing schema keeps its own type and every real property", () => {
    const injected = withIntentArgument({
      name: "hypothetical",
      title: "Hypothetical",
      description: "d",
      inputSchema: {
        type: "object",
        properties: { netuid: { type: "integer" } },
        required: ["netuid"],
        additionalProperties: false,
      },
      handler: async () => ({}),
    });
    const schema = injected.inputSchema as Row;
    assert.equal(schema.type, "object");
    assert.deepEqual(schema.required, ["netuid"]);
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(Object.keys(schema.properties as Row).sort(), [
      "context",
      "netuid",
    ]);
  });

  // The common case is a call with no context at all, so it must not pay for
  // the feature.
  test("arguments without context are passed through untouched", () => {
    const args = { netuid: 64 };
    const split = splitMcpIntent(args);
    assert.equal(split.rest, args, "same object, no copy");
    assert.equal(split.intent, undefined);
  });
});
