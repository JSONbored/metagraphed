// The three remaining holes in this server's MCP analytics, closed together
// because they are one question: does the $mcp_* family describe everything
// that happens on this surface, or only the parts that were easy to record?
//
//   1. $mcp_tool_description  — a documented property of $mcp_tool_call that
//                               was never sent, so a tool's failure rate could
//                               not be read against the text agents chose from.
//   2. refusals                — a rate-limited or unauthorized call produced a
//                               usage_event and NOTHING in the $mcp_* family,
//                               so every MCP Analytics error breakdown was
//                               computed over dispatched calls only and looked
//                               best exactly when the gate refused the most.
//   3. $mcp_missing_capability — the agent asked for something that does not
//                               exist. Previously invisible: no call, no error,
//                               no row, just an agent giving up.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  POSTHOG_PROJECT_TOKEN_ENV,
  classifyMcpErrorType,
} from "../src/usage-telemetry.ts";
import {
  MCP_MISSING_CAPABILITY_TOOL,
  handleMcpRequest,
  listToolDefinitions,
  mcpRefusalReason,
  alertTriggerErrorCode,
  mcpRefusalPath,
  scheduleMcpRefusalEvent,
} from "../src/mcp-server.ts";
import type { Row } from "./row-type.ts";

const CONFIGURED_ENV = { [POSTHOG_PROJECT_TOKEN_ENV]: "phc_test_token" };

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

async function callTool(name: string, args: Row = {}, extra: Row = {}) {
  const mcp: Row[] = [];
  const missing: Row[] = [];
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
      recordMcpToolCallEvent: (_e: unknown, event: Row) => {
        mcp.push(event);
        return true;
      },
      recordMcpMissingCapabilityEvent: (_e: unknown, event: Row) => {
        missing.push(event);
        return true;
      },
      ...extra,
    }),
  );
  return { mcp, missing, body: (await response.json()) as Row };
}

describe("$mcp_tool_description", () => {
  test("carries the registered description, read from the registry", async () => {
    const { mcp } = await callTool("get_contracts");

    const advertised = listToolDefinitions().find(
      (tool: Row) => tool.name === "get_contracts",
    ) as Row;
    assert.equal(mcp[0].toolDescription, advertised.description);
    assert.ok(
      String(mcp[0].toolDescription).length > 0,
      "the description should not be empty",
    );
  });

  test("is absent for a tool that does not exist", async () => {
    // There is no description to report for an unregistered name, and
    // inventing one would put text in the property that no agent ever read.
    const { mcp } = await callTool("no_such_tool_at_all");
    assert.equal(mcp[0].toolDescription, undefined);
  });
});

describe("pre-dispatch refusals reach the $mcp_* family", () => {
  // mcpRefusalReason's whole vocabulary, and the bucket each must land in.
  // A reason that classified as `internal` would be worse than not emitting:
  // it would report a rate limit as a server fault.
  for (const [status, headers, reason, bucket] of [
    [429, {}, "rate_limited", "rate_limited"],
    [
      429,
      { "x-ratelimit-scope": "daily-quota" },
      "daily_quota",
      "rate_limited",
    ],
    [429, { "x-ratelimit-scope": "blocked" }, "blocked", "permission"],
    [401, {}, "unauthorized", "permission"],
    [400, {}, "bad_request", "validation"],
    [405, {}, "method_not_allowed", "validation"],
    [413, {}, "body_too_large", "validation"],
    // Named after the refusal usage_event started landing and showed 8 of
    // these in six hours — a second SSE stream on a session that has one.
    [409, {}, "stream_taken", "validation"],
    [503, {}, "status_503", "api_5xx"],
    [418, {}, "status_418", "api_4xx"],
  ] as [number, Record<string, string>, string, string][]) {
    test(`${status} → ${reason} → ${bucket}`, async () => {
      const response = new Response("no", { status, headers });
      assert.equal(mcpRefusalReason(response), reason);
      assert.equal(classifyMcpErrorType(reason), bucket);

      const events: Row[] = [];
      const scheduled: Promise<unknown>[] = [];
      scheduleMcpRefusalEvent(
        new Request("https://api.metagraph.sh/mcp", {
          method: "POST",
          headers: { "user-agent": "probe/1.0", "mcp-session-id": "sess-1" },
        }),
        CONFIGURED_ENV as unknown as Env,
        {
          recordUsageEvent: () => true,
          recordMcpToolCallEvent: (_e: unknown, event: Row) => {
            events.push(event);
            return true;
          },
          executionCtx: {
            waitUntil: (p: Promise<unknown>) => scheduled.push(p),
          },
        },
        response,
        // A distinct clock per case, so the shared refusal throttle cannot
        // suppress the second and later cases and make them pass vacuously.
        Date.now() + status * 3_600_000,
      );

      assert.equal(events.length, 1, `no $mcp_tool_call for ${reason}`);
      assert.equal(events[0].isError, true);
      assert.equal(events[0].errorCode, reason);
      // No tool was named -- the gate refused in front of the dispatcher, and
      // attributing gate traffic to a real tool would corrupt its breakdown.
      assert.equal(events[0].toolName, undefined);
      assert.equal(events[0].sessionId, "sess-1");
      assert.equal(events[0].clientNameSource, "user_agent");
      // Both events go through waitUntil, never awaited in the MCP path.
      assert.equal(scheduled.length, 2);
    });
  }

  test("a refusal names the method and the masked path it arrived on", async () => {
    // #10810. A refusal has no tool by construction -- the gate runs in front of
    // the dispatcher -- so `$mcp_tool_name` is null and the error code was all
    // there was. That could not triage the largest refusal class on the surface:
    // 36 `method_not_allowed` in two days, with no way to separate a client
    // using a verb the transport does not implement from a scanner.
    const events: Row[] = [];
    scheduleMcpRefusalEvent(
      new Request("https://api.metagraph.sh/mcp/sess-abc123", {
        method: "DELETE",
      }),
      CONFIGURED_ENV as unknown as Env,
      {
        recordUsageEvent: () => true,
        recordMcpToolCallEvent: (_e: unknown, event: Row) => {
          events.push(event);
          return true;
        },
        executionCtx: { waitUntil: () => {} },
      },
      new Response("no", { status: 405 }),
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].requestMethod, "DELETE");
    assert.equal(events[0].toolName, undefined, "a refusal names no tool");
    // MASKED. An unmasked path would shard one recurring refusal across every
    // session id that produced it -- the same cardinality argument every other
    // route label in this codebase already makes.
    assert.equal(
      events[0].requestPath,
      "/mcp/:seg",
      `expected the session segment masked, got ${String(events[0].requestPath)}`,
    );
  });

  test("the refusal path is bounded whatever the caller sends", () => {
    // /mcp AND /mcp/* both route to the MCP handler, so the tail is caller
    // input on an event that is never sampled. maskRouteParams recognises ids
    // by SHAPE, which covers a UUID and not a scanner walking /mcp/aaa,
    // /mcp/bbb -- so anything it does not recognise gets one bucket, not one
    // bucket per probe.
    assert.equal(mcpRefusalPath("/mcp"), "/mcp");
    // A trailing slash is the SAME endpoint, so it must not be a second label.
    assert.equal(mcpRefusalPath("/mcp/"), "/mcp");
    assert.equal(
      mcpRefusalPath("/mcp/019fc81a-5c37-7012-970b-7871a621c410"),
      "/mcp/:uuid",
      "a recognised id keeps its own placeholder",
    );
    assert.equal(mcpRefusalPath("/mcp/4200000"), "/mcp/:n");
    // The whole point: unbounded caller input cannot shard the property -- and
    // DEPTH is caller input too, so a deeper probe must not buy a new label.
    const probes = [
      "aaa",
      "bbb",
      "sess-1",
      "../etc/passwd",
      "%00",
      "a/b/c/d/e/f",
    ].map((tail) => mcpRefusalPath(`/mcp/${tail}`));
    assert.deepEqual(new Set(probes), new Set(["/mcp/:seg"]));
  });

  test("a 2xx is not a refusal and records nothing", async () => {
    const events: Row[] = [];
    assert.equal(mcpRefusalReason(new Response("ok", { status: 200 })), null);
    scheduleMcpRefusalEvent(
      new Request("https://api.metagraph.sh/mcp", { method: "POST" }),
      CONFIGURED_ENV as unknown as Env,
      {
        recordUsageEvent: () => true,
        recordMcpToolCallEvent: (_e: unknown, event: Row) => {
          events.push(event);
          return true;
        },
        executionCtx: { waitUntil: () => {} },
      },
      new Response("ok", { status: 200 }),
    );
    assert.deepEqual(events, []);
  });

  test("a broken recorder never surfaces into the MCP path", () => {
    assert.doesNotThrow(() =>
      scheduleMcpRefusalEvent(
        new Request("https://api.metagraph.sh/mcp", { method: "POST" }),
        CONFIGURED_ENV as unknown as Env,
        {
          recordUsageEvent: () => true,
          recordMcpToolCallEvent: () => {
            throw new Error("posthog exploded");
          },
          executionCtx: { waitUntil: () => {} },
        },
        new Response("no", { status: 429 }),
        Date.now() + 99 * 3_600_000,
      ),
    );
  });
});

describe("the alert-triggers tier's status, classified (#10810)", () => {
  test("a caller's bad token is a permission failure, not a server fault", () => {
    // Every non-404 used to collapse into `alert_trigger_error`, which
    // classifyMcpErrorType buckets as `internal` -- "our bug". It was the ONLY
    // server-fault-classed MCP error in a 7-day production window, which put a
    // floor under the one signal that answers "is anything broken server-side"
    // and made that floor unreachable.
    for (const [status, code, type] of [
      [401, "auth_required", "permission"],
      [403, "forbidden", "permission"],
      [404, "not_found", "missing_context"],
      // The tier's own 400 -- "malformed trigger id", a non-object body -- is
      // the caller's request, refused.
      [400, "bad_request", "validation"],
      // Somebody else's 5xx, from the caller's side -- the reading
      // provider_error already carries for an adapter's upstream.
      [500, "provider_error", "api_5xx"],
      [503, "provider_error", "api_5xx"],
    ] as [number, string, string][]) {
      assert.equal(alertTriggerErrorCode(status), code, `HTTP ${status}`);
      assert.equal(classifyMcpErrorType(code), type, code);
    }
  });

  test("an unclassifiable status keeps the catch-all, and it still reads as internal", () => {
    // The point is not that nothing is `internal` any more -- a status we
    // cannot attribute genuinely is ours until proven otherwise. The point is
    // that the ones we CAN attribute no longer arrive there.
    assert.equal(alertTriggerErrorCode(418), "alert_trigger_error");
    assert.equal(classifyMcpErrorType("alert_trigger_error"), "internal");
  });
});

describe("$mcp_missing_capability", () => {
  test("the tool is advertised and answers without reading anything", async () => {
    const advertised = listToolDefinitions().find(
      (tool: Row) => tool.name === MCP_MISSING_CAPABILITY_TOOL,
    ) as Row;
    assert.ok(advertised, "get_more_tools should be in tools/list");
    // The reasoning rides on the standard intent argument, which is what puts
    // it in $mcp_intent rather than in a bespoke field nothing reads.
    assert.ok(
      Object.hasOwn(advertised.inputSchema?.properties ?? {}, "context"),
      "get_more_tools must accept `context`",
    );

    const { body } = await callTool(MCP_MISSING_CAPABILITY_TOOL, {
      context: "wanted per-validator slippage curves; nothing exposes them",
    });
    const data = body?.result?.structuredContent as Row;
    assert.equal(data.acknowledged, true);
    // It must not imply more tools are coming, or the agent retries forever.
    assert.equal(data.additional_tools_available, false);
  });

  test("records the agent's own words as the intent", async () => {
    const words = "wanted per-validator slippage curves; nothing exposes them";
    const { missing } = await callTool(MCP_MISSING_CAPABILITY_TOOL, {
      context: words,
    });

    assert.equal(missing.length, 1);
    assert.equal(missing[0].intent, words);
    assert.equal(typeof missing[0].serverVersion, "string");
  });

  test("a report with no reasoning is not counted", async () => {
    // An empty gap report names no gap. Counting it would inflate the tally of
    // unmet asks with calls that asked for nothing.
    const { missing, body } = await callTool(MCP_MISSING_CAPABILITY_TOOL, {});
    assert.deepEqual(missing, []);
    // ...but the tool still answers, so the agent is still told to stop.
    assert.equal(
      (body?.result?.structuredContent as Row).additional_tools_available,
      false,
    );
  });

  test("no other tool emits it", async () => {
    // Without this, a hook that fired on every call would pass every
    // assertion above.
    const { missing } = await callTool("get_contracts", {
      context: "checking the contract list",
    });
    assert.deepEqual(missing, []);
  });

  test("a broken recorder never surfaces into the tool path", async () => {
    const { body } = await callTool(
      MCP_MISSING_CAPABILITY_TOOL,
      { context: "something" },
      {
        recordMcpMissingCapabilityEvent: () => {
          throw new Error("posthog exploded");
        },
      },
    );
    assert.equal(body?.result?.isError, false);
  });

  test("an isolate that has already finished does not break the call", async () => {
    // scheduleMcpMissingCapabilityEvent's own try/catch: waitUntil throws once
    // the isolate is done, and that must stay a telemetry problem.
    const { body } = await callTool(
      MCP_MISSING_CAPABILITY_TOOL,
      { context: "something" },
      {
        executionCtx: {
          waitUntil() {
            throw new Error("isolate already finished");
          },
        },
      },
    );
    assert.equal(body?.result?.isError, false);
  });
});

describe("a non-string tool name is handled everywhere it is read", () => {
  // tools/call with a numeric `name` is malformed but reachable over the wire,
  // and three separate readers have to survive it: the label, the description
  // lookup, and the dispatcher itself.
  test("records no tool name and no description, and still refuses", async () => {
    const mcp: Row[] = [];
    const response = await handleMcpRequest(
      new Request("https://api.metagraph.sh/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: 42, arguments: {} },
        }),
      }),
      CONFIGURED_ENV as unknown as Env,
      makeDeps({
        recordMcpToolCallEvent: (_e: unknown, event: Row) => {
          mcp.push(event);
          return true;
        },
      }),
    );
    const body = (await response.json()) as Row;

    assert.equal(body?.result?.isError, true);
    assert.equal(mcp[0].toolName, undefined);
    assert.equal(mcp[0].toolDescription, undefined);
    assert.equal(mcp[0].errorCode, "unknown_tool");
  });
});

// The DEFAULT recorder paths, which every test above injects past.
//
// `ctx?.recordX ?? recordX` and `deps.fetch ?? globalThis.fetch` are the
// branches production actually takes — a real request injects nothing — and a
// suite that always passes a double never executes either side. Same reasoning
// and same shape as "falls back to the real recorder when none is injected" in
// tests/mcp-usage-telemetry.test.ts.
describe("the default recorders, with nothing injected", () => {
  async function withStubbedFetch(fn: () => Promise<void>) {
    const original = globalThis.fetch;
    const posted: Row[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      posted.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
      return { ok: true };
    }) as unknown as typeof fetch;
    try {
      await fn();
    } finally {
      globalThis.fetch = original;
    }
    return posted;
  }

  test("get_more_tools posts $mcp_missing_capability through the platform fetch", async () => {
    const scheduled: Promise<unknown>[] = [];
    const posted = await withStubbedFetch(async () => {
      await handleMcpRequest(
        new Request("https://api.metagraph.sh/mcp", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: MCP_MISSING_CAPABILITY_TOOL,
              arguments: { context: "needed per-validator slippage curves" },
            },
          }),
        }),
        CONFIGURED_ENV as unknown as Env,
        makeDeps({
          executionCtx: {
            waitUntil: (p: Promise<unknown>) => scheduled.push(p),
          },
        }),
      );
      // waitUntil defers the post, so it has to be drained before asserting.
      await Promise.all(scheduled);
    });

    const capability = posted.find(
      (p) => (p.body as Row).event === "$mcp_missing_capability",
    );
    assert.ok(capability, "the real recorder should have posted the event");
    const props = (capability.body as Row).properties as Row;
    assert.equal(props.$mcp_intent, "needed per-validator slippage curves");
    assert.equal(props.$mcp_intent_source, "context_parameter");
  });

  test("a refusal posts $mcp_tool_call through the platform fetch, with no user-agent", async () => {
    const scheduled: Promise<unknown>[] = [];
    const posted = await withStubbedFetch(async () => {
      scheduleMcpRefusalEvent(
        // No user-agent header at all: the `?? undefined` side of the client
        // read, which every other refusal test skips by sending one.
        new Request("https://api.metagraph.sh/mcp", { method: "POST" }),
        CONFIGURED_ENV as unknown as Env,
        {
          executionCtx: {
            waitUntil: (p: Promise<unknown>) => scheduled.push(p),
          },
        },
        new Response("no", { status: 429 }),
        // Far past every other case's window so the shared throttle admits it.
        Date.now() + 4242 * 3_600_000,
      );
      await Promise.all(scheduled);
    });

    const call = posted.find((p) => (p.body as Row).event === "$mcp_tool_call");
    assert.ok(call, "the real recorder should have posted the refusal");
    const props = (call.body as Row).properties as Row;
    assert.equal(props.$mcp_is_error, true);
    assert.equal(props.$mcp_error_code, "rate_limited");
    assert.equal(props.$mcp_error_type, "rate_limited");
    // No tool named, and no client name to report.
    assert.equal(Object.hasOwn(props, "$mcp_tool_name"), false);
    assert.equal(Object.hasOwn(props, "$mcp_client_name"), false);
    // usage_event rides alongside it on the same refusal.
    assert.ok(
      posted.some((p) => (p.body as Row).event === "usage_event"),
      "the usage_event should still post",
    );
  });
});
