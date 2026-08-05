import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  POSTHOG_CAPTURE_PATH,
  POSTHOG_EXCEPTION_STORM_WINDOW_MS_ENV,
  POSTHOG_HOST_ENV,
  POSTHOG_PROJECT_TOKEN_ENV,
  USAGE_EVENT_DISTINCT_ID,
  USAGE_EVENT_NAME,
  admitExceptionCapture,
  isBenignPlatformMessage,
  MCP_PROTOCOL_ROUTE_PREFIX,
  classifyMcpErrorType,
  resolveDeployment,
  isUsageTelemetryConfigured,
  recordAiDegradedEvent,
  recordAiEmbeddingEvent,
  recordAiGenerationEvent,
  recordExceptionEvent,
  recordMcpInitializeEvent,
  normalizeExceptionMessage,
  recordMcpToolCallEvent,
  recordMcpToolsListEvent,
  recordUsageEvent,
  resolvePostHogHost,
  resolveUsageSampleRate,
  POSTHOG_USAGE_SAMPLE_RATE_ENV,
  POSTHOG_USAGE_SAMPLE_RATES_ENV,
  statusClassOf,
  usageEventProperties,
} from "../src/usage-telemetry.ts";
import { mockEnv, type Row } from "./row-type.ts";
import type {
  AiGenerationEvent,
  ExceptionEvent,
  McpToolCallEvent,
  RecordUsageEventDeps,
  UsageEvent,
} from "../src/usage-telemetry.ts";

// A capture is one POST — record what it was handed, and let a test choose the
// outcome (accepted, rejected, transport failure).
function fakeFetch({
  onCall,
  ok = true,
  throws = false,
  response,
}: {
  onCall?: (call: Row) => void;
  ok?: boolean;
  throws?: boolean;
  response?: unknown;
} = {}) {
  return (async (url: unknown, init: Row) => {
    if (throws) throw new Error("network unreachable");
    onCall?.({ url, init, body: JSON.parse(init.body) });
    return response === undefined ? { ok } : response;
  }) as unknown as typeof fetch;
}

describe("isUsageTelemetryConfigured", () => {
  test("false when env is missing / token empty / whitespace", () => {
    assert.equal(isUsageTelemetryConfigured(undefined), false);
    assert.equal(isUsageTelemetryConfigured(mockEnv()), false);
    assert.equal(
      isUsageTelemetryConfigured({
        [POSTHOG_PROJECT_TOKEN_ENV]: "",
      } as unknown as Env),
      false,
    );
    assert.equal(
      isUsageTelemetryConfigured({
        [POSTHOG_PROJECT_TOKEN_ENV]: "   ",
      } as unknown as Env),
      false,
    );
    assert.equal(
      isUsageTelemetryConfigured({
        [POSTHOG_PROJECT_TOKEN_ENV]: 123,
      } as unknown as Env),
      false,
    );
  });

  test("true when a non-empty token string is set", () => {
    assert.equal(
      isUsageTelemetryConfigured({
        [POSTHOG_PROJECT_TOKEN_ENV]: "phc_test_token",
      } as unknown as Env),
      true,
    );
  });
});

describe("usageEventProperties", () => {
  test("returns null for missing ok or non-finite / negative duration", () => {
    assert.equal(usageEventProperties(null), null);
    assert.equal(
      usageEventProperties({ durationMs: 10 } as unknown as UsageEvent),
      null,
    );
    assert.equal(
      usageEventProperties({ ok: true } as unknown as UsageEvent),
      null,
    );
    assert.equal(
      usageEventProperties({ ok: true, durationMs: Number.NaN }),
      null,
    );
    assert.equal(usageEventProperties({ ok: true, durationMs: -1 }), null);
    assert.equal(
      usageEventProperties({
        ok: "yes",
        durationMs: 10,
      } as unknown as UsageEvent),
      null,
    );
  });

  test("allowlists only route / mcp_tool / ok / duration_ms / error_code", () => {
    assert.deepEqual(
      usageEventProperties({
        route: " /api/v1/subnets ",
        mcpTool: " get_subnet ",
        ok: true,
        durationMs: 12.6,
        args: { secret: "nope" },
        wallet: "5Fake",
      } as unknown as UsageEvent),
      {
        route: "/api/v1/subnets",
        mcp_tool: "get_subnet",
        ok: true,
        duration_ms: 13,
      },
    );
  });

  // metagraphed#7726: error_code categorizes why a failed call failed --
  // always one of a small set of literal codes the codebase itself defines,
  // never a caller-derived value or free-form message.
  test("includes error_code only when present and non-blank", () => {
    assert.deepEqual(
      usageEventProperties({
        ok: false,
        durationMs: 5,
        errorCode: "credential_not_supported",
      }),
      { ok: false, duration_ms: 5, error_code: "credential_not_supported" },
    );
    assert.deepEqual(usageEventProperties({ ok: false, durationMs: 5 }), {
      ok: false,
      duration_ms: 5,
    });
    assert.deepEqual(
      usageEventProperties({ ok: false, durationMs: 5, errorCode: "   " }),
      { ok: false, duration_ms: 5 },
    );
    // Present but irrelevant on a successful call -- still recorded verbatim
    // if supplied (this module trusts the caller not to set it on success;
    // mcp-server.ts's callTool enforces that contract at the call site).
    assert.deepEqual(
      usageEventProperties({
        ok: true,
        durationMs: 5,
        errorCode: "invalid_params",
      }),
      { ok: true, duration_ms: 5, error_code: "invalid_params" },
    );
  });

  test("omits blank optional labels and truncates overlong ones", () => {
    const long = "x".repeat(300);
    assert.deepEqual(
      usageEventProperties({
        route: "   ",
        mcpTool: long,
        ok: false,
        durationMs: 0,
      }),
      {
        mcp_tool: "x".repeat(256),
        ok: false,
        duration_ms: 0,
      },
    );
  });

  test("clamps absurd durations at 24h", () => {
    assert.equal(
      usageEventProperties({ ok: true, durationMs: 999_999_999 })!.duration_ms,
      86_400_000,
    );
  });
});

describe("resolvePostHogHost", () => {
  test("resolvePostHogHost trims a custom host or falls back to US cloud", () => {
    assert.equal(resolvePostHogHost(undefined), "https://us.i.posthog.com");
    assert.equal(
      resolvePostHogHost({
        [POSTHOG_HOST_ENV]: "  https://eu.i.posthog.com ",
      } as unknown as Env),
      "https://eu.i.posthog.com",
    );
    assert.equal(
      resolvePostHogHost({ [POSTHOG_HOST_ENV]: "   " } as unknown as Env),
      "https://us.i.posthog.com",
    );
  });
});

describe("recordUsageEvent — unconfigured (safe no-op)", () => {
  test("returns false and never issues a capture", async () => {
    let calls = 0;
    const recorded = await recordUsageEvent(
      mockEnv(),
      { route: "/api/v1/health", ok: true, durationMs: 5 },
      {
        fetch: fakeFetch({
          onCall: () => {
            calls += 1;
          },
        }),
      },
    );
    assert.equal(recorded, false);
    assert.equal(calls, 0);
  });

  test("never throws when env is null", async () => {
    await assert.doesNotReject(() =>
      recordUsageEvent(null, { ok: true, durationMs: 1 }),
    );
  });
});

describe("recordUsageEvent — configured", () => {
  test("posts one allowlisted usage_event to the capture endpoint", async () => {
    const calls: Row[] = [];
    const env = {
      [POSTHOG_PROJECT_TOKEN_ENV]: " phc_token ",
      [POSTHOG_HOST_ENV]: "https://eu.i.posthog.com",
    } as unknown as Env;

    const recorded = await recordUsageEvent(
      env,
      {
        route: "/api/v1/subnets/1",
        mcpTool: "get_subnet",
        ok: true,
        durationMs: 42,
      },
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );

    assert.equal(recorded, true);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      `https://eu.i.posthog.com${POSTHOG_CAPTURE_PATH}`,
    );
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.headers["content-type"], "application/json");
    assert.deepEqual(calls[0].body, {
      api_key: "phc_token",
      event: USAGE_EVENT_NAME,
      distinct_id: USAGE_EVENT_DISTINCT_ID,
      properties: {
        route: "/api/v1/subnets/1",
        mcp_tool: "get_subnet",
        ok: true,
        duration_ms: 42,
        // #9430: no CF_VERSION_METADATA binding in this env, which is what a
        // local `wrangler dev` isolate looks like — so the deployment reads
        // as development with no release. The production shape is asserted in
        // the resolveDeployment block below.
        environment: "development",
      },
    });
  });

  test("defaults host to PostHog US cloud when POSTHOG_HOST is unset", async () => {
    const calls: Row[] = [];
    await recordUsageEvent(
      { [POSTHOG_PROJECT_TOKEN_ENV]: "phc_token" } as unknown as Env,
      { ok: false, durationMs: 1 },
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    assert.equal(
      calls[0].url,
      `https://us.i.posthog.com${POSTHOG_CAPTURE_PATH}`,
    );
  });

  test("defaults to the platform fetch when none is injected", async () => {
    const original = globalThis.fetch;
    const calls: Row[] = [];
    globalThis.fetch = fakeFetch({ onCall: (call) => calls.push(call) });
    try {
      const recorded = await recordUsageEvent(
        { [POSTHOG_PROJECT_TOKEN_ENV]: "phc_token" } as unknown as Env,
        { ok: true, durationMs: 1 },
      );
      assert.equal(recorded, true);
      assert.equal(calls.length, 1);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("returns false for an invalid event without capturing", async () => {
    let calls = 0;
    const recorded = await recordUsageEvent(
      { [POSTHOG_PROJECT_TOKEN_ENV]: "phc_token" } as unknown as Env,
      { ok: true, durationMs: -5 },
      {
        fetch: fakeFetch({
          onCall: () => {
            calls += 1;
          },
        }),
      },
    );
    assert.equal(recorded, false);
    assert.equal(calls, 0);
  });

  test("swallows a transport failure", async () => {
    const recorded = await recordUsageEvent(
      { [POSTHOG_PROJECT_TOKEN_ENV]: "phc_token" } as unknown as Env,
      { ok: true, durationMs: 3 },
      { fetch: fakeFetch({ throws: true }) },
    );
    assert.equal(recorded, false);
  });

  test("reports a rejected capture as not recorded", async () => {
    const recorded = await recordUsageEvent(
      { [POSTHOG_PROJECT_TOKEN_ENV]: "phc_token" } as unknown as Env,
      { mcpTool: "list_tools", ok: true, durationMs: 9 },
      { fetch: fakeFetch({ ok: false }) },
    );
    assert.equal(recorded, false);
  });

  test("reports a missing response as not recorded", async () => {
    const recorded = await recordUsageEvent(
      { [POSTHOG_PROJECT_TOKEN_ENV]: "phc_token" } as unknown as Env,
      { ok: true, durationMs: 9 },
      { fetch: fakeFetch({ response: null }) },
    );
    assert.equal(recorded, false);
  });

  test("honors an injected distinctId override", async () => {
    const calls: Row[] = [];
    await recordUsageEvent(
      { [POSTHOG_PROJECT_TOKEN_ENV]: "phc_token" } as unknown as Env,
      { ok: true, durationMs: 2 },
      {
        distinctId: "test-distinct",
        fetch: fakeFetch({ onCall: (call) => calls.push(call) }),
      },
    );
    assert.equal(calls[0].body.distinct_id, "test-distinct");
  });
});

// #7737: recordMcpToolCallEvent is the one place $mcp_parameters/$mcp_response
// get built — there is no SDK instrument() pipeline redacting these for us
// (see the module's own header comment), so this redaction is the only thing
// standing between a real credential and PostHog.
describe("recordMcpToolCallEvent", () => {
  const CONFIGURED = {
    [POSTHOG_PROJECT_TOKEN_ENV]: "phc_token",
  } as unknown as Env;

  test("posts $mcp_tool_call with tool name / error flag / duration / session id", async () => {
    const calls: Row[] = [];
    const recorded = await recordMcpToolCallEvent(
      CONFIGURED,
      {
        toolName: "get_subnet",
        isError: false,
        durationMs: 12.4,
        sessionId: " sess-1 ",
      },
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    assert.equal(recorded, true);
    assert.equal(calls[0].body.event, "$mcp_tool_call");
    assert.deepEqual(calls[0].body.properties, {
      $mcp_is_error: false,
      $mcp_duration_ms: 12,
      $mcp_tool_name: "get_subnet",
      $session_id: "sess-1",
      // #9446: the deployment dimension every capture now carries.
      // No CF_VERSION_METADATA binding in this env, so it reads as a
      // local/undeployed isolate -- the production shape is asserted in
      // the resolveDeployment block.
      environment: "development",
    });
  });

  test("returns false for an invalid event without capturing", async () => {
    let calls = 0;
    const onCall = () => {
      calls += 1;
    };
    assert.equal(
      await recordMcpToolCallEvent(
        CONFIGURED,
        { isError: "yes", durationMs: 1 } as unknown as McpToolCallEvent,
        { fetch: fakeFetch({ onCall }) },
      ),
      false,
    );
    assert.equal(
      await recordMcpToolCallEvent(
        CONFIGURED,
        { isError: false, durationMs: -1 },
        { fetch: fakeFetch({ onCall }) },
      ),
      false,
    );
    assert.equal(calls, 0);
  });

  test("reports a rejected capture as not recorded", async () => {
    const recorded = await recordMcpToolCallEvent(
      CONFIGURED,
      { isError: false, durationMs: 1 },
      { fetch: fakeFetch({ ok: false }) },
    );
    assert.equal(recorded, false);
  });

  test("swallows a transport failure", async () => {
    const recorded = await recordMcpToolCallEvent(
      CONFIGURED,
      { isError: false, durationMs: 1 },
      { fetch: fakeFetch({ throws: true }) },
    );
    assert.equal(recorded, false);
  });

  // boundedMcpPayload's JSON.stringify can throw (a circular reference is the
  // realistic case here -- a tool response accidentally aliasing part of
  // itself) -- drop the field rather than let that reach the outer catch and
  // silently fail the whole event. A BigInt is the reliable way to trigger
  // this -- redactMcpSensitiveFields passes it through untouched (it's
  // neither an array nor a plain object), and JSON.stringify itself throws
  // on a BigInt.
  test("drops a payload that can't be JSON-serialized instead of failing the whole event", async () => {
    const calls: Row[] = [];
    const recorded = await recordMcpToolCallEvent(
      CONFIGURED,
      { isError: false, durationMs: 1, response: { big: 10n } },
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    assert.equal(recorded, true);
    assert.equal("$mcp_response" in calls[0].body.properties, false);
  });

  // JSON.stringify itself can also return undefined without throwing (a bare
  // function or symbol) -- a different branch than the BigInt case above.
  test("drops a payload JSON.stringify silently declines to serialize (e.g. a function)", async () => {
    const calls: Row[] = [];
    const recorded = await recordMcpToolCallEvent(
      CONFIGURED,
      { isError: false, durationMs: 1, response: () => {} },
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    assert.equal(recorded, true);
    assert.equal("$mcp_response" in calls[0].body.properties, false);
  });

  test("defaults to the platform fetch when none is injected", async () => {
    const original = globalThis.fetch;
    const calls: Row[] = [];
    globalThis.fetch = fakeFetch({ onCall: (call) => calls.push(call) });
    try {
      const recorded = await recordMcpToolCallEvent(CONFIGURED, {
        isError: false,
        durationMs: 1,
      });
      assert.equal(recorded, true);
      assert.equal(calls.length, 1);
    } finally {
      globalThis.fetch = original;
    }
  });

  // A self-referential response is a realistic caller mistake (e.g. an error
  // object aliasing its own cause chain), not just deep-but-acyclic data --
  // the depth guard defuses it the same way, so this never throws or hangs.
  test("does not loop forever on a circular reference", async () => {
    const circular: Row = {};
    circular.self = circular;
    const calls: Row[] = [];
    const recorded = await recordMcpToolCallEvent(
      CONFIGURED,
      { isError: false, durationMs: 1, response: circular },
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    assert.equal(recorded, true);
    assert.ok(calls[0].body.properties.$mcp_response !== undefined);
  });

  test("omits $mcp_parameters / $mcp_response entirely when not supplied", async () => {
    const calls: Row[] = [];
    await recordMcpToolCallEvent(
      CONFIGURED,
      { isError: false, durationMs: 1 },
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    assert.equal("$mcp_parameters" in calls[0].body.properties, false);
    assert.equal("$mcp_response" in calls[0].body.properties, false);
  });

  test("redacts a string credential (bearer/api-key/basic shape) out of $mcp_parameters", async () => {
    const calls: Row[] = [];
    await recordMcpToolCallEvent(
      CONFIGURED,
      {
        isError: false,
        durationMs: 1,
        parameters: {
          surface_id: "x:api:6",
          credential: "Bearer super-secret-abc123",
        },
      },
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    assert.ok(!JSON.stringify(calls[0].body).includes("super-secret-abc123"));
    assert.deepEqual(calls[0].body.properties.$mcp_parameters, {
      surface_id: "x:api:6",
      credential: "[redacted]",
    });
  });

  // call_subnet_surface's signature-bundle shape (#7701): an object whose own
  // key names are caller-defined (the surface's auth.names) -- the whole
  // value is dropped rather than trying to redact by nested key name.
  test("redacts an object-shaped signature-bundle credential regardless of its own key names", async () => {
    const calls: Row[] = [];
    await recordMcpToolCallEvent(
      CONFIGURED,
      {
        isError: false,
        durationMs: 1,
        parameters: {
          surface_id: "x:api:6",
          credential: { hotkey: "5FakeHotkey", nonce: "top-secret-nonce" },
        },
      },
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    const serialized = JSON.stringify(calls[0].body);
    assert.ok(!serialized.includes("top-secret-nonce"));
    assert.ok(!serialized.includes("5FakeHotkey"));
    assert.equal(
      calls[0].body.properties.$mcp_parameters.credential,
      "[redacted]",
    );
  });

  test("redacts owner_token via the same generic key-name pattern (no project-specific special case)", async () => {
    const calls: Row[] = [];
    await recordMcpToolCallEvent(
      CONFIGURED,
      {
        isError: false,
        durationMs: 1,
        parameters: { id: "trigger-1", owner_token: "owner-secret-xyz" },
      },
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    assert.ok(!JSON.stringify(calls[0].body).includes("owner-secret-xyz"));
    assert.deepEqual(calls[0].body.properties.$mcp_parameters, {
      id: "trigger-1",
      owner_token: "[redacted]",
    });
  });

  test("redacts nested sensitive keys inside $mcp_response too, not just $mcp_parameters", async () => {
    const calls: Row[] = [];
    await recordMcpToolCallEvent(
      CONFIGURED,
      {
        isError: false,
        durationMs: 1,
        response: {
          ok: true,
          body: { access_token: "leaked-if-not-redacted", data: [1, 2, 3] },
        },
      },
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    assert.ok(
      !JSON.stringify(calls[0].body).includes("leaked-if-not-redacted"),
    );
    assert.deepEqual(calls[0].body.properties.$mcp_response, {
      ok: true,
      body: { access_token: "[redacted]", data: [1, 2, 3] },
    });
  });

  test("leaves non-sensitive fields untouched", async () => {
    const calls: Row[] = [];
    await recordMcpToolCallEvent(
      CONFIGURED,
      {
        isError: false,
        durationMs: 1,
        parameters: { surface_id: "x:api:6", query: { page: 2 } },
      },
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    assert.deepEqual(calls[0].body.properties.$mcp_parameters, {
      surface_id: "x:api:6",
      query: { page: 2 },
    });
  });

  test("truncates an oversized payload instead of shipping it whole", async () => {
    const calls: Row[] = [];
    await recordMcpToolCallEvent(
      CONFIGURED,
      { isError: false, durationMs: 1, response: { data: "x".repeat(10_000) } },
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    const sent = calls[0].body.properties.$mcp_response;
    assert.equal(sent.truncated, true);
    assert.ok(sent.preview.length <= 4096);
  });

  // A secret buried past the recursion cap must never reach the payload,
  // even unredacted-by-key-name -- the depth guard drops the whole subtree
  // rather than risk a stack overflow trying to inspect it.
  test("does not overflow, and never leaks, on a pathologically deep structure", async () => {
    let deep: Row = { credential: "leaf-secret" };
    for (let i = 0; i < 50; i += 1) deep = { nested: deep };
    const calls: Row[] = [];
    await assert.doesNotReject(() =>
      recordMcpToolCallEvent(
        CONFIGURED,
        { isError: false, durationMs: 1, response: deep },
        { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
      ),
    );
    assert.equal(calls.length, 1);
    assert.ok(!JSON.stringify(calls[0].body).includes("leaf-secret"));
  });

  test("never posts when the deployment is unconfigured, even with a credential present", async () => {
    let calls = 0;
    const recorded = await recordMcpToolCallEvent(
      mockEnv(),
      { isError: false, durationMs: 1, parameters: { credential: "x" } },
      {
        fetch: fakeFetch({
          onCall: () => {
            calls += 1;
          },
        }),
      },
    );
    assert.equal(recorded, false);
    assert.equal(calls, 0);
  });
});

describe("recordMcpInitializeEvent", () => {
  const CONFIGURED = {
    [POSTHOG_PROJECT_TOKEN_ENV]: "phc_token",
  } as unknown as Env;

  test("posts $mcp_initialize with client name / version / session id", async () => {
    const calls: Row[] = [];
    const recorded = await recordMcpInitializeEvent(
      CONFIGURED,
      {
        clientName: " claude-code ",
        clientVersion: " 1.2.3 ",
        sessionId: " sess-1 ",
      },
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    assert.equal(recorded, true);
    assert.equal(calls[0].body.event, "$mcp_initialize");
    assert.deepEqual(calls[0].body.properties, {
      $mcp_client_name: "claude-code",
      // #8963: the handshake is the one place an MCP-declared client identity
      // is authoritative, so it is labelled as such rather than as the
      // User-Agent guess a tool call has to fall back on.
      $mcp_client_name_source: "client_info",
      $mcp_client_version: "1.2.3",
      $session_id: "sess-1",
      // #9446: the deployment dimension every capture now carries.
      // No CF_VERSION_METADATA binding in this env, so it reads as a
      // local/undeployed isolate -- the production shape is asserted in
      // the resolveDeployment block.
      environment: "development",
    });
  });

  test("omits client name / version / session id when blank or absent", async () => {
    const calls: Row[] = [];
    await recordMcpInitializeEvent(
      CONFIGURED,
      {},
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    // #9446: `environment` is the deployment dimension every capture now
    // carries; no CF_VERSION_METADATA binding here, so it reads as a
    // local/undeployed isolate. Everything the caller omitted is still
    // absent, which is what this test is actually about.
    assert.deepEqual(calls[0].body.properties, {
      environment: "development",
    });
  });

  test("defaults to the platform fetch when none is injected", async () => {
    const original = globalThis.fetch;
    const calls: Row[] = [];
    globalThis.fetch = fakeFetch({ onCall: (call) => calls.push(call) });
    try {
      const recorded = await recordMcpInitializeEvent(CONFIGURED, {
        clientName: "claude-code",
      });
      assert.equal(recorded, true);
      assert.equal(calls.length, 1);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("never posts when the deployment is unconfigured", async () => {
    let calls = 0;
    const recorded = await recordMcpInitializeEvent(
      mockEnv(),
      { clientName: "claude-code" },
      {
        fetch: fakeFetch({
          onCall: () => {
            calls += 1;
          },
        }),
      },
    );
    assert.equal(recorded, false);
    assert.equal(calls, 0);
  });

  test("reports a rejected capture as not recorded", async () => {
    const recorded = await recordMcpInitializeEvent(
      CONFIGURED,
      { clientName: "claude-code" },
      { fetch: fakeFetch({ ok: false }) },
    );
    assert.equal(recorded, false);
  });

  test("swallows a transport failure", async () => {
    const recorded = await recordMcpInitializeEvent(
      CONFIGURED,
      { clientName: "claude-code" },
      { fetch: fakeFetch({ throws: true }) },
    );
    assert.equal(recorded, false);
  });
});

// #7758: schema verified directly against PostHog's own ingestion Rust types
// (rust/cymbal/src/core/types/{exception,stacktrace}.rs,
// rust/cymbal/src/core/types/langs/custom.rs) and a real production
// $exception fixture, not just the docs page -- see the module's own header
// comment for the sources. These tests pin that shape so a future refactor
// can't silently drift from it.
describe("recordExceptionEvent", () => {
  test("drops a Durable Object code-update reset without sending anything", async () => {
    // Expected on every deploy, self-healing, and raised by all four DOs --
    // the per-isolate change-detectors cannot suppress it because the reset
    // is what wipes the isolate holding the memo.
    const calls: Row[] = [];
    const recorded = await recordExceptionEvent(
      CONFIGURED,
      {
        error: new Error("Durable Object reset because its code was updated."),
        route: "head-poller",
      },
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    assert.equal(recorded, false);
    assert.equal(calls.length, 0);
  });

  test("a genuine fault on the same route is still captured after a reset was dropped", async () => {
    // The suppression runs BEFORE the storm guard, so a dropped platform
    // message must not have consumed head-poller's throttle window.
    const calls: Row[] = [];
    const deps = { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) };
    await recordExceptionEvent(
      CONFIGURED,
      {
        error: new Error("Durable Object reset because its code was updated."),
        route: "reset-route",
      },
      deps,
    );
    const recorded = await recordExceptionEvent(
      CONFIGURED,
      { error: new Error("real fault"), route: "reset-route" },
      deps,
    );
    assert.equal(recorded, true);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].body.properties.$exception_list[0].value,
      "real fault",
    );
  });

  test("isBenignPlatformMessage matches only the exact runtime prefix", () => {
    assert.equal(
      isBenignPlatformMessage(
        "Durable Object reset because its code was updated.",
      ),
      true,
    );
    // A real fault that merely mentions the same subject must NOT be swallowed.
    assert.equal(
      isBenignPlatformMessage("failed to reach Durable Object reset endpoint"),
      false,
    );
    assert.equal(isBenignPlatformMessage("boom"), false);
  });

  test("stamps frames with the chunk id of the file they came from", async () => {
    // Models production faithfully: `posthog-cli sourcemap inject` prepends an
    // IIFE that registers globalThis._posthogChunkIds[<a stack captured INSIDE
    // the bundle>] = <uuid>. @posthog/core keys that map BY FILENAME (#9068),
    // which is strictly stronger than the single-chunk-only helper #9048
    // hand-wrote -- so the registration stack and the thrown error's frames
    // must name the same file, exactly as they do in a real deploy.
    const scope = globalThis as { _posthogChunkIds?: Record<string, string> };
    const before = scope._posthogChunkIds;
    scope._posthogChunkIds = {
      "Error\n    at Object.<anonymous> (/bundle/data-api.js:1:1)":
        "019fc1c0-8505-7612-a464-f3a75098a9ea",
    };
    try {
      const error = new Error("boom");
      error.stack =
        "Error: boom\n" +
        "    at handler (/bundle/data-api.js:93344:18)\n" +
        "    at fetch (/bundle/data-api.js:18040:61)";
      const calls: Row[] = [];
      await recordExceptionEvent(
        CONFIGURED,
        { error, route: "test-route" },
        { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
      );
      const frames =
        calls[0].body.properties.$exception_list[0].stacktrace.frames;
      assert.ok(frames.length > 0);
      for (const frame of frames) {
        assert.equal(frame.chunk_id, "019fc1c0-8505-7612-a464-f3a75098a9ea");
      }
    } finally {
      if (before === undefined) delete scope._posthogChunkIds;
      else scope._posthogChunkIds = before;
    }
  });

  test("omits chunk_id entirely when nothing injected a marker", async () => {
    // Local dev, tests, and any deploy that skipped inject: the key must be
    // ABSENT rather than present-and-empty, which PostHog would try to resolve.
    const scope = globalThis as { _posthogChunkIds?: Record<string, string> };
    const before = scope._posthogChunkIds;
    delete scope._posthogChunkIds;
    try {
      const calls: Row[] = [];
      await recordExceptionEvent(
        CONFIGURED,
        { error: new RangeError("boom"), route: "test-route" },
        { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
      );
      const frames =
        calls[0].body.properties.$exception_list[0].stacktrace.frames;
      assert.ok(frames.length > 0);
      for (const frame of frames) {
        assert.equal("chunk_id" in frame, false);
      }
    } finally {
      if (before !== undefined) scope._posthogChunkIds = before;
    }
  });

  const CONFIGURED = {
    [POSTHOG_PROJECT_TOKEN_ENV]: "phc_token",
  } as unknown as Env;

  function thrownError(ErrorClass: ErrorConstructor, message: string) {
    // A real thrown-and-caught error, not a hand-built object -- so
    // error.stack is a genuine V8 stack string, same as every real call site.
    try {
      throw new ErrorClass(message);
    } catch (e) {
      return e;
    }
  }

  test("posts a well-formed $exception event for a real thrown Error", async () => {
    const calls: Row[] = [];
    const recorded = await recordExceptionEvent(
      CONFIGURED,
      {
        error: thrownError(RangeError, "boom"),
        route: "test-route",
        errorCode: "internal_error",
      },
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    assert.equal(recorded, true);
    const { body } = calls[0];
    assert.equal(body.event, "$exception");
    assert.equal(body.api_key, "phc_token");
    assert.equal(body.distinct_id, USAGE_EVENT_DISTINCT_ID);

    const list = body.properties.$exception_list;
    assert.equal(list.length, 1);
    assert.equal(list[0].type, "RangeError");
    assert.equal(list[0].value, "boom");
    // `type` comes from @posthog/core's builder (#9068); handled/synthetic are
    // the hint we pass in.
    assert.deepEqual(list[0].mechanism, {
      handled: true,
      synthetic: false,
      type: "generic",
    });
    assert.equal(list[0].stacktrace.type, "raw");
    assert.ok(list[0].stacktrace.frames.length > 0);
    for (const frame of list[0].stacktrace.frames) {
      // The marker that makes PostHog SYMBOLICATE the frame rather than take
      // it at face value (#9045). Now emitted by @posthog/core's parser
      // (#9068) rather than set by hand, so it cannot drift.
      assert.equal(frame.platform, "node:javascript");
      assert.equal(typeof frame.function, "string");
    }

    assert.equal(
      body.properties.$exception_fingerprint,
      "test-route:RangeError",
    );
    assert.equal(body.properties.route, "test-route");
    assert.equal(body.properties.error_code, "internal_error");
  });

  test("orders frames oldest-call-first (thrown frame last), matching the Sentry-derived protocol", async () => {
    function inner() {
      throw new Error("deep");
    }
    function outer() {
      inner();
    }
    let error;
    try {
      outer();
    } catch (e) {
      error = e;
    }

    const calls: Row[] = [];
    await recordExceptionEvent(
      CONFIGURED,
      { error, route: "x" },
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    const frames =
      calls[0].body.properties.$exception_list[0].stacktrace.frames;
    // The innermost/throwing frame ("inner") must be LAST, not first.
    assert.equal(frames.at(-1).function, "inner");
    assert.equal(frames.at(-2).function, "outer");
  });

  test("marks node_modules frames as not in_app, everything else as in_app", async () => {
    const fakeStack =
      "Error: boom\n" +
      "    at ourFunction (/repo/src/usage-telemetry.ts:10:5)\n" +
      "    at vendorFunction (/repo/node_modules/some-pkg/index.js:20:3)\n";
    const error = new Error("boom");
    error.stack = fakeStack;

    const calls: Row[] = [];
    await recordExceptionEvent(
      CONFIGURED,
      { error, route: "x" },
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    const frames =
      calls[0].body.properties.$exception_list[0].stacktrace.frames;
    const ours = frames.find((f: Row) => f.function === "ourFunction");
    const vendor = frames.find((f: Row) => f.function === "vendorFunction");
    assert.equal(ours.in_app, true);
    assert.equal(vendor.in_app, false);
  });

  test("parses filename/lineno/colno out of a standard V8 frame line", async () => {
    const fakeStack =
      "Error: boom\n" + "    at doThing (/repo/src/foo.ts:42:13)\n";
    const error = new Error("boom");
    error.stack = fakeStack;

    const calls: Row[] = [];
    await recordExceptionEvent(
      CONFIGURED,
      { error, route: "x" },
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    const [frame] =
      calls[0].body.properties.$exception_list[0].stacktrace.frames;
    assert.equal(frame.function, "doThing");
    assert.equal(frame.filename, "/repo/src/foo.ts");
    assert.equal(frame.lineno, 42);
    assert.equal(frame.colno, 13);
  });

  test("drops an unparseable stack line rather than emitting a junk frame", async () => {
    // BEHAVIOUR CHANGE (#9068): the hand-written parser kept any line it could
    // not parse as a pseudo-frame whose `function` was the raw text.
    // @posthog/core's parser drops it. That is the better contract -- a frame
    // with no file/line/col cannot be symbolicated and only adds noise to the
    // Issue -- and it is now the library's to maintain, not ours.
    const error = new Error("boom");
    error.stack =
      "Error: boom\n" + "    something unusual, not a normal V8 frame\n";

    const calls: Row[] = [];
    await recordExceptionEvent(
      CONFIGURED,
      { error, route: "x" },
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    const frames =
      calls[0].body.properties.$exception_list[0].stacktrace.frames;
    assert.equal(frames.length, 0);
    // The exception itself still reports fully -- only the junk frame is gone.
    assert.equal(calls[0].body.properties.$exception_list[0].value, "boom");
  });

  test("caps the number of stack frames sent", async () => {
    const many = Array.from(
      { length: 200 },
      (_, i) => `    at fn${i} (/repo/src/foo.ts:${i}:1)`,
    ).join("\n");
    const error = new Error("boom");
    error.stack = `Error: boom\n${many}`;

    const calls: Row[] = [];
    await recordExceptionEvent(
      CONFIGURED,
      { error, route: "x" },
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    const frames =
      calls[0].body.properties.$exception_list[0].stacktrace.frames;
    // @posthog/core's STACKTRACE_FRAME_LIMIT (#9068); was 30 when we capped it
    // ourselves.
    assert.ok(frames.length <= 50);
    assert.ok(frames.length > 0);
  });

  test("handles a thrown non-Error value without crashing", async () => {
    const calls: Row[] = [];
    const recorded = await recordExceptionEvent(
      CONFIGURED,
      { error: "just a string", route: "x" },
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    assert.equal(recorded, true);
    const entry = calls[0].body.properties.$exception_list[0];
    assert.equal(entry.type, "Error");
    assert.equal(entry.value, "just a string");
    // A thrown string has no stack, so @posthog/core's StringCoercer omits
    // `stacktrace` entirely (#9068) rather than emitting an empty frame list
    // the way our hand-written shaper did. Omission is the honest shape.
    assert.equal(entry.stacktrace, undefined);
  });

  test("falls back to a generic type/message when an Error has a blank name/message", async () => {
    const error = new Error("");
    error.name = "";
    const calls: Row[] = [];
    await recordExceptionEvent(
      CONFIGURED,
      { error, route: "x" },
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    const entry = calls[0].body.properties.$exception_list[0];
    assert.equal(entry.type, "Error");
    assert.equal(entry.value, "(no message)");
  });

  test("falls back to a generic type when an Error's name is truthy but whitespace-only", async () => {
    // Distinct from the blank-name case above: "" is falsy (the ternary
    // itself picks the "Error" literal), but "   " is a truthy non-empty
    // string (the ternary picks it), and only THEN does sanitizeLabel find
    // it blank and fall back -- a different branch in the same expression.
    const error = new Error("boom");
    error.name = "   ";
    const calls: Row[] = [];
    await recordExceptionEvent(
      CONFIGURED,
      { error, route: "x" },
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    assert.equal(calls[0].body.properties.$exception_list[0].type, "Error");
  });

  test("caps an overlong message the same way sanitizeLabel caps every other free-form field", async () => {
    const error = new Error("x".repeat(1000));
    const calls: Row[] = [];
    await recordExceptionEvent(
      CONFIGURED,
      { error, route: "x" },
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    const entry = calls[0].body.properties.$exception_list[0];
    assert.equal(entry.value.length, 256);
  });

  test("falls back to mcpTool for the fingerprint and properties when route is absent", async () => {
    const calls: Row[] = [];
    await recordExceptionEvent(
      CONFIGURED,
      {
        error: thrownError(TypeError, "bad arg"),
        mcpTool: "call_subnet_surface",
      },
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    const { properties } = calls[0].body;
    assert.equal(properties.mcp_tool, "call_subnet_surface");
    assert.equal("route" in properties, false);
    assert.equal(
      properties.$exception_fingerprint,
      "call_subnet_surface:TypeError",
    );
  });

  test("falls back to 'unknown' in the fingerprint when neither route nor mcpTool is given", async () => {
    const calls: Row[] = [];
    await recordExceptionEvent(
      CONFIGURED,
      { error: thrownError(Error, "boom") },
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    assert.equal(
      calls[0].body.properties.$exception_fingerprint,
      "unknown:Error",
    );
  });

  test("omits error_code when not supplied", async () => {
    const calls: Row[] = [];
    await recordExceptionEvent(
      CONFIGURED,
      { error: thrownError(Error, "boom"), route: "x" },
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    assert.equal("error_code" in calls[0].body.properties, false);
  });

  // #9459: query attribution has to arrive WITHOUT splitting the issue, or the
  // storm guard's per-fingerprint window turns one event per window into N.
  test("query attribution rides as properties and leaves the fingerprint alone", async () => {
    const calls: Row[] = [];
    await recordExceptionEvent(
      CONFIGURED,
      {
        error: thrownError(Error, "The operation was aborted"),
        route: "r2-sql",
        errorCode: "timeout",
        queryKind: "chain.account_events",
        queryShape: "SELECT netuid FROM chain.account_events WHERE x >= ?",
      },
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    const { properties } = calls[0].body;
    assert.equal(properties.query_kind, "chain.account_events");
    assert.equal(
      properties.query_shape,
      "SELECT netuid FROM chain.account_events WHERE x >= ?",
    );
    assert.equal(properties.error_code, "timeout");
    // The load-bearing assertion: still `route:type`, with nothing about the
    // query folded in. A second query kind on this route must land in the SAME
    // PostHog issue and so must cost the same one event per window.
    assert.equal(properties.$exception_fingerprint, "r2-sql:Error");
  });

  test("omits query_kind / query_shape when not supplied", async () => {
    // Omitted-not-defaulted, the same contract sample_rate and error_code
    // keep: every pre-existing capture site's payload is byte-identical.
    const calls: Row[] = [];
    await recordExceptionEvent(
      CONFIGURED,
      { error: thrownError(Error, "boom"), route: "x" },
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    assert.equal("query_kind" in calls[0].body.properties, false);
    assert.equal("query_shape" in calls[0].body.properties, false);
  });

  test("a query shape longer than the label cap is truncated, not dropped", async () => {
    const calls: Row[] = [];
    await recordExceptionEvent(
      CONFIGURED,
      {
        error: thrownError(Error, "boom"),
        route: "r2-sql",
        queryShape: `SELECT ${"a".repeat(400)} FROM chain.blocks`,
      },
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    // 256 = MAX_LABEL_CHARS, shared with every other free-form field here, so
    // a pathological statement cannot ship an unbounded payload.
    assert.equal(calls[0].body.properties.query_shape.length, 256);
  });

  test("never posts when the deployment is unconfigured", async () => {
    let calls = 0;
    const recorded = await recordExceptionEvent(
      mockEnv(),
      { error: thrownError(Error, "boom"), route: "x" },
      {
        fetch: fakeFetch({
          onCall: () => {
            calls += 1;
          },
        }),
      },
    );
    assert.equal(recorded, false);
    assert.equal(calls, 0);
  });

  test("returns false for a malformed event without capturing", async () => {
    let calls = 0;
    const onCall = () => {
      calls += 1;
    };
    assert.equal(
      await recordExceptionEvent(
        CONFIGURED,
        null as unknown as ExceptionEvent,
        {
          fetch: fakeFetch({ onCall }),
        },
      ),
      false,
    );
    assert.equal(
      await recordExceptionEvent(
        CONFIGURED,
        undefined as unknown as ExceptionEvent,
        {
          fetch: fakeFetch({ onCall }),
        },
      ),
      false,
    );
    assert.equal(calls, 0);
  });

  test("reports a rejected capture as not recorded", async () => {
    const recorded = await recordExceptionEvent(
      CONFIGURED,
      { error: thrownError(Error, "boom"), route: "x" },
      { fetch: fakeFetch({ ok: false }) },
    );
    assert.equal(recorded, false);
  });

  test("swallows a transport failure", async () => {
    const recorded = await recordExceptionEvent(
      CONFIGURED,
      { error: thrownError(Error, "boom"), route: "x" },
      { fetch: fakeFetch({ throws: true }) },
    );
    assert.equal(recorded, false);
  });

  test("defaults to the platform fetch when none is injected", async () => {
    const original = globalThis.fetch;
    const calls: Row[] = [];
    globalThis.fetch = fakeFetch({ onCall: (call) => calls.push(call) });
    try {
      const recorded = await recordExceptionEvent(CONFIGURED, {
        error: thrownError(Error, "boom"),
        route: "x",
      });
      assert.equal(recorded, true);
      assert.equal(calls.length, 1);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("recordAiGenerationEvent", () => {
  const CONFIGURED = {
    [POSTHOG_PROJECT_TOKEN_ENV]: "phc_token",
  } as unknown as Env;

  function thrownError(ErrorClass: ErrorConstructor, message: string) {
    try {
      throw new ErrorClass(message);
    } catch (e) {
      return e;
    }
  }

  const BASE: AiGenerationEvent = {
    provider: "cloudflare_workers_ai",
    model: "@cf/meta/llama-4-scout-17b-16e-instruct",
    latencyMs: 1500,
    isError: false,
  };

  test("posts a well-formed $ai_generation event for a successful call", async () => {
    const calls: Row[] = [];
    const recorded = await recordAiGenerationEvent(
      CONFIGURED,
      {
        ...BASE,
        traceId: "11111111-1111-1111-1111-111111111111",
        traceName: "ask",
        inputTokens: 200,
        outputTokens: 50,
        inputCostUsd: 0.000054,
        outputCostUsd: 0.0000425,
        modelParameters: { max_tokens: 512 },
        input: [{ role: "user", content: "which subnet does X?" }],
        outputChoices: [{ role: "assistant", content: "Subnet 5 does X." }],
      },
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    assert.equal(recorded, true);
    const { body } = calls[0];
    assert.equal(body.event, "$ai_generation");
    assert.equal(body.api_key, "phc_token");
    assert.equal(body.distinct_id, USAGE_EVENT_DISTINCT_ID);

    const { properties } = body;
    assert.equal(
      properties.$ai_trace_id,
      "11111111-1111-1111-1111-111111111111",
    );
    assert.equal(properties.$ai_trace_name, "ask");
    assert.equal(properties.$ai_model, BASE.model);
    assert.equal(properties.$ai_provider, "cloudflare_workers_ai");
    assert.equal(properties.$ai_latency, 1.5);
    assert.equal(properties.$ai_http_status, 200);
    assert.equal(properties.$ai_input_tokens, 200);
    assert.equal(properties.$ai_output_tokens, 50);
    assert.equal(properties.$ai_is_error, false);
    assert.deepEqual(properties.$ai_model_parameters, { max_tokens: 512 });
    assert.deepEqual(properties.$ai_input, [
      { role: "user", content: "which subnet does X?" },
    ]);
    assert.deepEqual(properties.$ai_output_choices, [
      { role: "assistant", content: "Subnet 5 does X." },
    ]);
    assert.equal(properties.$ai_input_cost_usd, 0.000054);
    assert.equal(properties.$ai_output_cost_usd, 0.0000425);
    assert.equal(properties.$ai_total_cost_usd, 0.0000965);
    assert.equal("$ai_error" in properties, false);
  });

  test("omits trace name/input/output when not supplied -- these are optional, not required", async () => {
    const calls: Row[] = [];
    await recordAiGenerationEvent(CONFIGURED, BASE, {
      fetch: fakeFetch({ onCall: (call) => calls.push(call) }),
    });
    const { properties } = calls[0].body;
    assert.equal("$ai_trace_name" in properties, false);
    assert.equal("$ai_input" in properties, false);
    assert.equal("$ai_output_choices" in properties, false);
  });

  test("omits input/output when supplied as empty arrays", async () => {
    const calls: Row[] = [];
    await recordAiGenerationEvent(
      CONFIGURED,
      { ...BASE, input: [], outputChoices: [] },
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    const { properties } = calls[0].body;
    assert.equal("$ai_input" in properties, false);
    assert.equal("$ai_output_choices" in properties, false);
  });

  test("mints a fresh trace id when none is supplied", async () => {
    const calls: Row[] = [];
    await recordAiGenerationEvent(CONFIGURED, BASE, {
      fetch: fakeFetch({ onCall: (call) => calls.push(call) }),
    });
    const traceId = calls[0].body.properties.$ai_trace_id;
    assert.equal(typeof traceId, "string");
    // A real crypto.randomUUID() shape (v4 UUID), not a placeholder.
    assert.match(
      traceId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  test("defaults input/output tokens to 0 when omitted", async () => {
    const calls: Row[] = [];
    await recordAiGenerationEvent(CONFIGURED, BASE, {
      fetch: fakeFetch({ onCall: (call) => calls.push(call) }),
    });
    assert.equal(calls[0].body.properties.$ai_input_tokens, 0);
    assert.equal(calls[0].body.properties.$ai_output_tokens, 0);
  });

  test("defaults tokens to 0 when the supplied values are non-finite", async () => {
    const calls: Row[] = [];
    await recordAiGenerationEvent(
      CONFIGURED,
      { ...BASE, inputTokens: NaN, outputTokens: Infinity },
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    assert.equal(calls[0].body.properties.$ai_input_tokens, 0);
    assert.equal(calls[0].body.properties.$ai_output_tokens, 0);
  });

  test("omits cost fields entirely when cost is not supplied", async () => {
    const calls: Row[] = [];
    await recordAiGenerationEvent(CONFIGURED, BASE, {
      fetch: fakeFetch({ onCall: (call) => calls.push(call) }),
    });
    const { properties } = calls[0].body;
    assert.equal("$ai_input_cost_usd" in properties, false);
    assert.equal("$ai_output_cost_usd" in properties, false);
    assert.equal("$ai_total_cost_usd" in properties, false);
  });

  test("omits cost fields when only one side of input/output cost is supplied", async () => {
    const calls: Row[] = [];
    await recordAiGenerationEvent(
      CONFIGURED,
      { ...BASE, inputCostUsd: 0.01 },
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    assert.equal("$ai_input_cost_usd" in calls[0].body.properties, false);
  });

  test("omits $ai_model_parameters when not supplied", async () => {
    const calls: Row[] = [];
    await recordAiGenerationEvent(CONFIGURED, BASE, {
      fetch: fakeFetch({ onCall: (call) => calls.push(call) }),
    });
    assert.equal("$ai_model_parameters" in calls[0].body.properties, false);
  });

  test("falls back to 'unknown' for a blank model/provider", async () => {
    const calls: Row[] = [];
    await recordAiGenerationEvent(
      CONFIGURED,
      { ...BASE, model: "", provider: "   " },
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    assert.equal(calls[0].body.properties.$ai_model, "unknown");
    assert.equal(calls[0].body.properties.$ai_provider, "unknown");
  });

  test("marks a failed generation with $ai_is_error/$ai_http_status/$ai_error", async () => {
    const calls: Row[] = [];
    const recorded = await recordAiGenerationEvent(
      CONFIGURED,
      { ...BASE, isError: true, error: thrownError(Error, "AI.run failed") },
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    assert.equal(recorded, true);
    const { properties } = calls[0].body;
    assert.equal(properties.$ai_is_error, true);
    assert.equal(properties.$ai_http_status, 500);
    assert.equal(properties.$ai_error, "Error: AI.run failed");
  });

  test("handles a thrown non-Error value on the error path without crashing", async () => {
    const calls: Row[] = [];
    await recordAiGenerationEvent(
      CONFIGURED,
      { ...BASE, isError: true, error: "just a string" },
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    assert.equal(calls[0].body.properties.$ai_error, "Error: just a string");
  });

  test("never posts when the deployment is unconfigured", async () => {
    let calls = 0;
    const recorded = await recordAiGenerationEvent(mockEnv(), BASE, {
      fetch: fakeFetch({
        onCall: () => {
          calls += 1;
        },
      }),
    });
    assert.equal(recorded, false);
    assert.equal(calls, 0);
  });

  test("returns false without posting when isError is not a boolean", async () => {
    let calls = 0;
    const recorded = await recordAiGenerationEvent(
      CONFIGURED,
      { ...BASE, isError: undefined as unknown as boolean },
      {
        fetch: fakeFetch({
          onCall: () => {
            calls += 1;
          },
        }),
      },
    );
    assert.equal(recorded, false);
    assert.equal(calls, 0);
  });

  test("returns false without posting when latencyMs is negative/non-finite", async () => {
    let calls = 0;
    const onCall = () => {
      calls += 1;
    };
    assert.equal(
      await recordAiGenerationEvent(
        CONFIGURED,
        { ...BASE, latencyMs: -1 },
        { fetch: fakeFetch({ onCall }) },
      ),
      false,
    );
    assert.equal(
      await recordAiGenerationEvent(
        CONFIGURED,
        { ...BASE, latencyMs: NaN },
        { fetch: fakeFetch({ onCall }) },
      ),
      false,
    );
    assert.equal(calls, 0);
  });

  test("reports a rejected capture as not recorded", async () => {
    const recorded = await recordAiGenerationEvent(CONFIGURED, BASE, {
      fetch: fakeFetch({ ok: false }),
    });
    assert.equal(recorded, false);
  });

  test("swallows a transport failure", async () => {
    const recorded = await recordAiGenerationEvent(CONFIGURED, BASE, {
      fetch: fakeFetch({ throws: true }),
    });
    assert.equal(recorded, false);
  });

  test("defaults to the platform fetch when none is injected", async () => {
    const original = globalThis.fetch;
    const calls: Row[] = [];
    globalThis.fetch = fakeFetch({ onCall: (call) => calls.push(call) });
    try {
      const recorded = await recordAiGenerationEvent(CONFIGURED, BASE);
      assert.equal(recorded, true);
      assert.equal(calls.length, 1);
    } finally {
      globalThis.fetch = original;
    }
  });
});

// Shared by the #8963 blocks below — same shape as the per-describe constant
// the earlier suites declare locally.
const CONFIGURED_8963 = {
  [POSTHOG_PROJECT_TOKEN_ENV]: "phc_token",
} as unknown as Env;

// ─── #8963: the completed $mcp_* property contract ─────────────────────────

describe("classifyMcpErrorType", () => {
  // Every code observed on a real failing tool call in production over the 7
  // days to 2026-08-01, with the bucket it must land in. This is the list the
  // issue's acceptance criterion is about: a breakdown by $mcp_error_type has
  // to be meaningful for the failures that actually happen, not for a
  // hypothetical vocabulary.
  const PRODUCTION_CODES: [string, string][] = [
    ["not_found", "missing_context"],
    ["tier_unavailable", "api_5xx"],
    ["data_rate_limited", "rate_limited"],
    ["invalid_params", "validation"],
    ["upstream_unavailable", "api_5xx"],
    ["unsupported_content_type", "validation"],
    ["auth_required", "permission"],
    ["emission_pipeline_unavailable", "api_5xx"],
    ["rpc_invalid_request", "validation"],
    ["rpc_method_blocked", "permission"],
    ["internal_error", "internal"],
    ["unknown_tool", "validation"],
    // Added after production caught this one falling through to `internal`.
    // The bare code has no underscore prefix, so the `_rate_limited$` rule did
    // not match it. It is what requireAiRateLimit raises, i.e. the most common
    // member of the family -- it simply had not occurred in the 7-day window
    // the rest of this list was built from.
    ["rate_limited", "rate_limited"],
  ];

  test("classifies every error code seen in production", () => {
    for (const [code, expected] of PRODUCTION_CODES) {
      assert.equal(classifyMcpErrorType(code), expected, `code ${code}`);
    }
  });

  test("classifies the long tail by naming convention", () => {
    // These reach toolError from helper modules that mint their own codes and
    // are the reason the classifier is not a hand-maintained lookup alone.
    assert.equal(
      classifyMcpErrorType("account_balances_sync_unavailable"),
      "api_5xx",
    );
    assert.equal(classifyMcpErrorType("provider_unreachable"), "api_5xx");
    assert.equal(
      classifyMcpErrorType("webhook_subscription_rate_limited"),
      "rate_limited",
    );
    assert.equal(classifyMcpErrorType("invalid_direction"), "validation");
    assert.equal(
      classifyMcpErrorType("provider_not_configured"),
      "missing_context",
    );
  });

  // The gap that shipped: every member of a family must be checked, not just
  // the prefixed variants that happened to appear in a sample.
  test("classifies every rate-limit variant, bare and prefixed", () => {
    for (const code of [
      "rate_limited",
      "data_rate_limited",
      "graphql_rate_limited",
      "rpc_state_query_rate_limited",
      "webhook_subscription_rate_limited",
    ]) {
      assert.equal(classifyMcpErrorType(code), "rate_limited", code);
    }
  });

  test("classifies the codes an audit found falling through to internal", () => {
    assert.equal(classifyMcpErrorType("insufficient_liquidity"), "validation");
    assert.equal(classifyMcpErrorType("provider_error"), "api_5xx");
    assert.equal(classifyMcpErrorType("provider_invalid_response"), "api_5xx");
    assert.equal(classifyMcpErrorType("retired_artifact"), "missing_context");
    assert.equal(classifyMcpErrorType("api_key_blocked"), "permission");
  });

  // `server_error` genuinely IS internal -- ours, not a dependency's -- so it
  // must stay in the fallback bucket rather than being swept up by a rule.
  test("leaves a genuinely internal code in the internal bucket", () => {
    assert.equal(classifyMcpErrorType("server_error"), "internal");
  });

  test("rate-limit codes win over the unavailable rule", () => {
    // rpc_state_query_rate_limited matches neither rule cleanly if the 5xx
    // pattern is checked first — precedence is load-bearing here.
    assert.equal(
      classifyMcpErrorType("rpc_state_query_rate_limited"),
      "rate_limited",
    );
  });

  test("never leaves a failure unclassified", () => {
    for (const value of [
      undefined,
      null,
      "",
      "   ",
      42,
      "something_nobody_has_written_yet",
    ]) {
      assert.equal(classifyMcpErrorType(value), "internal");
    }
  });
});

describe("recordMcpToolCallEvent — #8963 properties", () => {
  test("stamps error type, error code, client and server attribution", async () => {
    const calls: Row[] = [];
    await recordMcpToolCallEvent(
      CONFIGURED_8963,
      {
        toolName: "get_subnet_ownership_history",
        isError: true,
        durationMs: 37,
        errorCode: "tier_unavailable",
        clientName: "claude-code",
        clientVersion: "2.1.220",
        clientNameSource: "user_agent",
        serverName: "metagraphed",
        serverVersion: "1.78.12",
      } as McpToolCallEvent,
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    const props = calls[0].body.properties;
    assert.equal(props.$mcp_error_type, "api_5xx");
    assert.equal(props.$mcp_error_code, "tier_unavailable");
    assert.equal(props.$mcp_client_name, "claude-code");
    assert.equal(props.$mcp_client_name_source, "user_agent");
    assert.equal(props.$mcp_client_version, "2.1.220");
    assert.equal(props.$mcp_server_name, "metagraphed");
    assert.equal(props.$mcp_server_version, "1.78.12");
    assert.equal(props.$mcp_duration_ms, 37);
  });

  // #8967 / ADR 0027. Authentication on /mcp buys throughput, not reach, and
  // the whole point of this dimension is that clause is revisitable against
  // data: without it, "what share of MCP traffic is authenticated" -- the
  // question any decision to extend the tier system starts from -- has no
  // answer at all.
  test("stamps the auth tier for a keyed caller", async () => {
    const calls: Row[] = [];
    await recordMcpToolCallEvent(
      CONFIGURED_8963,
      {
        toolName: "get_subnet",
        isError: false,
        durationMs: 5,
        authTier: "paid",
      } as McpToolCallEvent,
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    assert.equal(calls[0].body.properties.$mcp_auth_tier, "paid");
  });

  // "anonymous" is emitted as a VALUE, not as an absence. An unlabelled event
  // would otherwise be ambiguous between "anonymous caller" and "emitted
  // before this dimension shipped", which are different facts.
  test("stamps anonymous as an explicit tier, not an omission", async () => {
    const calls: Row[] = [];
    await recordMcpToolCallEvent(
      CONFIGURED_8963,
      {
        toolName: "get_subnet",
        isError: false,
        durationMs: 5,
        authTier: "anonymous",
      } as McpToolCallEvent,
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    assert.equal(calls[0].body.properties.$mcp_auth_tier, "anonymous");
  });

  test("omits the auth tier when none was resolved", async () => {
    const calls: Row[] = [];
    await recordMcpToolCallEvent(
      CONFIGURED_8963,
      { toolName: "get_subnet", isError: false, durationMs: 5 },
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    assert.equal(calls[0].body.properties.$mcp_auth_tier, undefined);
  });

  test("emits no error classification on a successful call", async () => {
    const calls: Row[] = [];
    await recordMcpToolCallEvent(
      CONFIGURED_8963,
      { toolName: "get_subnet", isError: false, durationMs: 5 },
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    const props = calls[0].body.properties;
    assert.ok(!("$mcp_error_type" in props));
    assert.ok(!("$mcp_error_code" in props));
  });

  test("classifies an error with no code rather than dropping it", async () => {
    const calls: Row[] = [];
    await recordMcpToolCallEvent(
      CONFIGURED_8963,
      { toolName: "get_subnet", isError: true, durationMs: 5 },
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    const props = calls[0].body.properties;
    assert.equal(props.$mcp_error_type, "internal");
    assert.ok(!("$mcp_error_code" in props));
  });

  // Cloudflare Workers freeze Date.now() between I/O operations, so a call
  // that rejects before doing any I/O measures exactly 0 — a fabricated value,
  // not a fast call. 15% of production error events carried this zero.
  test("omits duration entirely when the clock never advanced", async () => {
    const calls: Row[] = [];
    await recordMcpToolCallEvent(
      CONFIGURED_8963,
      { toolName: "get_subnet", isError: true, durationMs: 0 },
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    assert.ok(!("$mcp_duration_ms" in calls[0].body.properties));
  });

  test("still records a genuine sub-millisecond duration once rounded up", async () => {
    const calls: Row[] = [];
    await recordMcpToolCallEvent(
      CONFIGURED_8963,
      { toolName: "get_subnet", isError: false, durationMs: 0.6 },
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    assert.equal(calls[0].body.properties.$mcp_duration_ms, 1);
  });
});

describe("recordMcpToolsListEvent", () => {
  test("posts $mcp_tools_list with the advertised tool count", async () => {
    const calls: Row[] = [];
    const recorded = await recordMcpToolsListEvent(
      CONFIGURED_8963,
      {
        toolCount: 207,
        sessionId: " sess-9 ",
        clientName: "mcpregistry",
        clientNameSource: "user_agent",
        serverName: "metagraphed",
        serverVersion: "1.78.12",
      },
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    assert.equal(recorded, true);
    assert.equal(calls[0].body.event, "$mcp_tools_list");
    assert.deepEqual(calls[0].body.properties, {
      $mcp_tools_count: 207,
      $mcp_client_name: "mcpregistry",
      $mcp_client_name_source: "user_agent",
      $mcp_server_name: "metagraphed",
      $mcp_server_version: "1.78.12",
      $session_id: "sess-9",
      // #9446: the deployment dimension every capture now carries.
      // No CF_VERSION_METADATA binding in this env, so it reads as a
      // local/undeployed isolate -- the production shape is asserted in
      // the resolveDeployment block.
      environment: "development",
    });
  });

  test("omits a nonsensical tool count", async () => {
    const calls: Row[] = [];
    await recordMcpToolsListEvent(
      CONFIGURED_8963,
      { toolCount: Number.NaN },
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    assert.ok(!("$mcp_tools_count" in calls[0].body.properties));
  });

  test("is a no-op without a configured project token", async () => {
    const calls: Row[] = [];
    const recorded = await recordMcpToolsListEvent(
      mockEnv({}),
      { toolCount: 1 },
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    assert.equal(recorded, false);
    assert.equal(calls.length, 0);
  });

  test("swallows a transport failure", async () => {
    const recorded = await recordMcpToolsListEvent(
      CONFIGURED_8963,
      { toolCount: 1 },
      { fetch: fakeFetch({ throws: true }) },
    );
    assert.equal(recorded, false);
  });

  test("defaults to the platform fetch when none is injected", async () => {
    const original = globalThis.fetch;
    const calls: Row[] = [];
    globalThis.fetch = fakeFetch({ onCall: (call) => calls.push(call) });
    try {
      const recorded = await recordMcpToolsListEvent(CONFIGURED_8963, {
        toolCount: 1,
      });
      assert.equal(recorded, true);
      assert.equal(calls.length, 1);
    } finally {
      globalThis.fetch = original;
    }
  });
});

// ─── #8963: usage_event dimensions ─────────────────────────────────────────

describe("statusClassOf", () => {
  test("buckets a real status by its hundreds digit", () => {
    assert.equal(statusClassOf(200), "2xx");
    assert.equal(statusClassOf(204), "2xx");
    assert.equal(statusClassOf(301), "3xx");
    assert.equal(statusClassOf(404), "4xx");
    assert.equal(statusClassOf(429), "4xx");
    assert.equal(statusClassOf(500), "5xx");
    assert.equal(statusClassOf(599), "5xx");
  });

  test("refuses anything that is not a status we could have produced", () => {
    // A bucket that silently absorbed garbage would be worse than no bucket:
    // it would look like real traffic in every breakdown.
    for (const value of [99, 600, 0, -1, Number.NaN, "200", null, undefined]) {
      assert.equal(statusClassOf(value), undefined, `status ${String(value)}`);
    }
  });
});

describe("usageEventProperties — #8963 dimensions", () => {
  test("records method (uppercased), status class, and client", () => {
    assert.deepEqual(
      usageEventProperties({
        route: "/api/v1/subnets",
        ok: true,
        durationMs: 12,
        method: "get",
        statusClass: "2xx",
        client: "claude-code",
      }),
      {
        route: "/api/v1/subnets",
        ok: true,
        duration_ms: 12,
        method: "GET",
        status_class: "2xx",
        client: "claude-code",
      },
    );
  });

  test("omits each dimension when absent or blank, never defaulting one", () => {
    assert.deepEqual(
      usageEventProperties({
        ok: true,
        durationMs: 1,
        method: "   ",
        statusClass: "",
        client: undefined,
      }),
      { ok: true, duration_ms: 1 },
    );
  });

  test("caps an overlong client label like every other free-form field", () => {
    const props = usageEventProperties({
      ok: true,
      durationMs: 1,
      client: "x".repeat(300),
    });
    assert.equal(String(props!.client).length, 256);
  });
});

// ─── #8965: embedding + degraded-path observability ────────────────────────

const CONFIGURED_8965 = {
  [POSTHOG_PROJECT_TOKEN_ENV]: "phc_token",
} as unknown as Env;

function capture8965() {
  const calls: Row[] = [];
  return {
    calls,
    deps: { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
  };
}

describe("recordAiEmbeddingEvent", () => {
  test("posts $ai_embedding with model, latency in seconds, and batch size", async () => {
    const { calls, deps } = capture8965();
    const recorded = await recordAiEmbeddingEvent(
      CONFIGURED_8965,
      {
        provider: "cloudflare_workers_ai",
        model: "@cf/qwen/qwen3-embedding-0.6b",
        traceId: "trace-1",
        traceName: "ask",
        latencyMs: 250,
        isError: false,
        inputTokens: 18,
        inputCount: 1,
      },
      deps,
    );
    assert.equal(recorded, true);
    assert.equal(calls[0].body.event, "$ai_embedding");
    const props = calls[0].body.properties;
    assert.equal(props.$ai_trace_id, "trace-1");
    assert.equal(props.$ai_trace_name, "ask");
    // PostHog reports latency in SECONDS, matching $ai_generation.
    assert.equal(props.$ai_latency, 0.25);
    assert.equal(props.$ai_http_status, 200);
    assert.equal(props.$ai_input_tokens, 18);
    assert.equal(props.$ai_input_count, 1);
    assert.equal(props.$ai_is_error, false);
  });

  // Workers AI's embedding response has no `usage` object, so in production
  // this is ALWAYS the case. Reporting 0 would be the same fabricated-value
  // defect #8963 fixed for durations, and would drag every sum or average
  // over embeddings toward zero.
  test("omits the token count when the model reports none, rather than sending 0", async () => {
    const { calls, deps } = capture8965();
    await recordAiEmbeddingEvent(
      CONFIGURED_8965,
      {
        provider: "cloudflare_workers_ai",
        model: "@cf/qwen/qwen3-embedding-0.6b",
        latencyMs: 12,
        isError: false,
        inputCount: 1,
      },
      deps,
    );
    const props = calls[0].body.properties;
    assert.ok(!("$ai_input_tokens" in props));
    // The call itself is still counted -- that is what makes per-call billing
    // readable without a token count.
    assert.equal(props.$ai_input_count, 1);
  });

  test("never reports a cost — Workers AI bills embeddings in neurons", async () => {
    const { calls, deps } = capture8965();
    await recordAiEmbeddingEvent(
      CONFIGURED_8965,
      {
        provider: "cloudflare_workers_ai",
        model: "m",
        latencyMs: 1,
        isError: false,
      },
      deps,
    );
    const props = calls[0].body.properties;
    // A fabricated cost would poison the same dashboards $ai_generation feeds
    // honestly, so the column is left genuinely empty.
    assert.ok(!("$ai_total_cost_usd" in props));
    assert.ok(!("$ai_input_cost_usd" in props));
  });

  test("mints a trace id when the caller supplies none", async () => {
    const { calls, deps } = capture8965();
    await recordAiEmbeddingEvent(
      CONFIGURED_8965,
      { provider: "p", model: "m", latencyMs: 1, isError: false },
      deps,
    );
    assert.equal(typeof calls[0].body.properties.$ai_trace_id, "string");
  });

  test("records the error text and a 500 status on failure", async () => {
    const { calls, deps } = capture8965();
    await recordAiEmbeddingEvent(
      CONFIGURED_8965,
      {
        provider: "p",
        model: "m",
        latencyMs: 5,
        isError: true,
        error: new TypeError("embedding model returned no vector"),
      },
      deps,
    );
    const props = calls[0].body.properties;
    assert.equal(props.$ai_is_error, true);
    assert.equal(props.$ai_http_status, 500);
    assert.match(String(props.$ai_error), /embedding model returned no vector/);
  });

  test("rejects a malformed event rather than posting it", async () => {
    const { calls, deps } = capture8965();
    for (const event of [
      { provider: "p", model: "m", latencyMs: 1 },
      { provider: "p", model: "m", latencyMs: -1, isError: false },
      { provider: "p", model: "m", latencyMs: Number.NaN, isError: false },
    ]) {
      assert.equal(
        await recordAiEmbeddingEvent(
          CONFIGURED_8965,
          event as Parameters<typeof recordAiEmbeddingEvent>[1],
          deps,
        ),
        false,
      );
    }
    assert.equal(calls.length, 0);
  });

  test("is a no-op unconfigured and swallows a transport failure", async () => {
    const { calls, deps } = capture8965();
    assert.equal(
      await recordAiEmbeddingEvent(
        mockEnv({}),
        { provider: "p", model: "m", latencyMs: 1, isError: false },
        deps,
      ),
      false,
    );
    assert.equal(calls.length, 0);
    assert.equal(
      await recordAiEmbeddingEvent(
        CONFIGURED_8965,
        { provider: "p", model: "m", latencyMs: 1, isError: false },
        { fetch: fakeFetch({ throws: true }) },
      ),
      false,
    );
  });

  test("defaults to the platform fetch when none is injected", async () => {
    const original = globalThis.fetch;
    const calls: Row[] = [];
    globalThis.fetch = fakeFetch({ onCall: (call) => calls.push(call) });
    try {
      assert.equal(
        await recordAiEmbeddingEvent(CONFIGURED_8965, {
          provider: "p",
          model: "m",
          latencyMs: 1,
          isError: false,
        }),
        true,
      );
      assert.equal(calls.length, 1);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("recordAiDegradedEvent", () => {
  test("posts ai_degraded with the reason and surface", async () => {
    const { calls, deps } = capture8965();
    const recorded = await recordAiDegradedEvent(
      CONFIGURED_8965,
      { reason: "rate_limited", surface: "ask" },
      deps,
    );
    assert.equal(recorded, true);
    assert.equal(calls[0].body.event, "ai_degraded");
    assert.deepEqual(calls[0].body.properties, {
      reason: "rate_limited",
      surface: "ask",
      // #9446: the deployment dimension every capture now carries.
      // No CF_VERSION_METADATA binding in this env, so it reads as a
      // local/undeployed isolate -- the production shape is asserted in
      // the resolveDeployment block.
      environment: "development",
    });
  });

  test("omits an absent surface", async () => {
    const { calls, deps } = capture8965();
    await recordAiDegradedEvent(
      CONFIGURED_8965,
      { reason: "ai_disabled" },
      deps,
    );
    // #9446: `environment` is the deployment dimension every capture now
    // carries; no CF_VERSION_METADATA binding here, so it reads as a
    // local/undeployed isolate. `surface` is still absent, which is what
    // this test is actually about.
    assert.deepEqual(calls[0].body.properties, {
      reason: "ai_disabled",
      environment: "development",
    });
  });

  test("rejects an event with no reason", async () => {
    const { calls, deps } = capture8965();
    assert.equal(
      await recordAiDegradedEvent(
        CONFIGURED_8965,
        {} as Parameters<typeof recordAiDegradedEvent>[1],
        deps,
      ),
      false,
    );
    assert.equal(calls.length, 0);
  });

  test("is a no-op unconfigured and swallows a transport failure", async () => {
    const { calls, deps } = capture8965();
    assert.equal(
      await recordAiDegradedEvent(
        mockEnv({}),
        { reason: "rate_limited" },
        deps,
      ),
      false,
    );
    assert.equal(calls.length, 0);
    assert.equal(
      await recordAiDegradedEvent(
        CONFIGURED_8965,
        { reason: "rate_limited" },
        { fetch: fakeFetch({ throws: true }) },
      ),
      false,
    );
  });

  test("defaults to the platform fetch when none is injected", async () => {
    const original = globalThis.fetch;
    const calls: Row[] = [];
    globalThis.fetch = fakeFetch({ onCall: (call) => calls.push(call) });
    try {
      assert.equal(
        await recordAiDegradedEvent(CONFIGURED_8965, {
          reason: "rate_limited",
        }),
        true,
      );
      assert.equal(calls.length, 1);
    } finally {
      globalThis.fetch = original;
    }
  });
});

// #9019: PostHog's Error Tracking groups Issues by the exception MESSAGE, not
// by our $exception_fingerprint. Hyperdrive names each pooled connection in its
// error text, so every dropped connection minted a new Issue — ~15 near-
// identical single-occurrence rows for one fault, burying the ones that matter.
describe("normalizeExceptionMessage", () => {
  test("collapses per-connection Hyperdrive hosts into one message", () => {
    const a = normalizeExceptionMessage(
      "write CONNECTION_CLOSED 1f462de30803897f4c87cfe341e93970.hyperdrive.local:5432",
    );
    const b = normalizeExceptionMessage(
      "write CONNECTION_CLOSED 5c01896f5cccb129888261dcc240daee.hyperdrive.local:5432",
    );
    assert.equal(a, b);
    assert.equal(
      a,
      "write CONNECTION_CLOSED <connection>.hyperdrive.local:5432",
    );
  });

  // The half that stops this being a footgun. A relation name IS the diagnostic
  // content — normalizing it would have merged #8960's five distinct drifted
  // objects into one indistinguishable Issue, which is the opposite of the goal.
  test("leaves identifiers that ARE the diagnosis alone", () => {
    for (const msg of [
      'relation "api_usage_rollup" does not exist',
      'relation "tao_usd_index" does not exist',
      'column "tao_in_emission_tao" does not exist',
    ]) {
      assert.equal(normalizeExceptionMessage(msg), msg);
    }
    // ...and they stay distinct from each other.
    assert.notEqual(
      normalizeExceptionMessage('relation "api_usage_rollup" does not exist'),
      normalizeExceptionMessage('relation "tao_usd_index" does not exist'),
    );
  });

  test("leaves unrelated messages untouched", () => {
    for (const msg of [
      "canceling statement due to statement timeout",
      "DATA_API returned 502",
      "",
    ]) {
      assert.equal(normalizeExceptionMessage(msg), msg);
    }
  });

  // A short hex run is not a connection id, and a hyperdrive-looking host that
  // is not hex must not be rewritten either — the pattern is narrow on purpose.
  test("does not over-match", () => {
    assert.equal(
      normalizeExceptionMessage("connect abc.hyperdrive.local:5432"),
      "connect abc.hyperdrive.local:5432",
    );
    assert.equal(
      normalizeExceptionMessage("deadbeef.example.com failed"),
      "deadbeef.example.com failed",
    );
  });
});

describe("usage_event sampling (free-tier budget)", () => {
  const token = { [POSTHOG_PROJECT_TOKEN_ENV]: "phc_token" };

  test("unsampled by default, so no test's call counts turn flaky", () => {
    assert.equal(
      resolveUsageSampleRate(mockEnv(token), { ok: true, durationMs: 1 }),
      1,
    );
  });

  test("the deployment default applies to a route with no override", () => {
    const env = mockEnv({ ...token, [POSTHOG_USAGE_SAMPLE_RATE_ENV]: "0.2" });
    assert.equal(
      resolveUsageSampleRate(env, {
        route: "subnets",
        ok: true,
        durationMs: 1,
      }),
      0.2,
    );
    assert.equal(
      resolveUsageSampleRate(env, { ok: true, durationMs: 1 }),
      0.2,
      "an event with no route still gets the default",
    );
  });

  test("a per-route override beats the default", () => {
    const env = mockEnv({
      ...token,
      [POSTHOG_USAGE_SAMPLE_RATE_ENV]: "0.2",
      [POSTHOG_USAGE_SAMPLE_RATES_ENV]: '{"block-detail":0.01}',
    });
    assert.equal(
      resolveUsageSampleRate(env, {
        route: "block-detail",
        ok: true,
        durationMs: 1,
      }),
      0.01,
    );
    assert.equal(
      resolveUsageSampleRate(env, { route: "health", ok: true, durationMs: 1 }),
      0.2,
      "a route absent from the map falls back to the default",
    );
  });

  test("failures and MCP tool calls are NEVER sampled", () => {
    const env = mockEnv({
      ...token,
      [POSTHOG_USAGE_SAMPLE_RATE_ENV]: "0.01",
      [POSTHOG_USAGE_SAMPLE_RATES_ENV]: '{"block-detail":0.01}',
    });
    assert.equal(
      resolveUsageSampleRate(env, {
        route: "block-detail",
        ok: false,
        durationMs: 1,
      }),
      1,
      "a rare failure must never be sampled away",
    );
    assert.equal(
      resolveUsageSampleRate(env, {
        mcpTool: "get_subnet",
        ok: true,
        durationMs: 1,
      }),
      1,
      "MCP is the product signal and is low-volume",
    );
  });

  test("a malformed or out-of-range rate degrades to unsampled, never to zero", () => {
    for (const bad of ["", "  ", "abc", "-0.5", "1.5", "NaN"]) {
      assert.equal(
        resolveUsageSampleRate(
          mockEnv({ ...token, [POSTHOG_USAGE_SAMPLE_RATE_ENV]: bad }),
          { ok: true, durationMs: 1 },
        ),
        1,
        `rate "${bad}" should fall back to unsampled`,
      );
    }
  });

  test("a malformed override map is ignored, and every route keeps the default", () => {
    for (const bad of ['{"block-detail":', "[1,2,3]", "null", '"a string"']) {
      assert.equal(
        resolveUsageSampleRate(
          mockEnv({
            ...token,
            [POSTHOG_USAGE_SAMPLE_RATE_ENV]: "0.5",
            [POSTHOG_USAGE_SAMPLE_RATES_ENV]: bad,
          }),
          { route: "block-detail", ok: true, durationMs: 1 },
        ),
        0.5,
        `map "${bad}" should be ignored`,
      );
    }
  });

  test("an out-of-range entry inside the map is dropped, others survive", () => {
    const env = mockEnv({
      ...token,
      [POSTHOG_USAGE_SAMPLE_RATE_ENV]: "0.5",
      [POSTHOG_USAGE_SAMPLE_RATES_ENV]:
        '{"block-detail":2,"health":0.1,"subnets":"x"}',
    });
    assert.equal(
      resolveUsageSampleRate(env, {
        route: "block-detail",
        ok: true,
        durationMs: 1,
      }),
      0.5,
    );
    assert.equal(
      resolveUsageSampleRate(env, { route: "health", ok: true, durationMs: 1 }),
      0.1,
    );
    assert.equal(
      resolveUsageSampleRate(env, {
        route: "subnets",
        ok: true,
        durationMs: 1,
      }),
      0.5,
    );
  });

  test("the parsed map is reused across calls with the same raw value", () => {
    const env = mockEnv({
      ...token,
      [POSTHOG_USAGE_SAMPLE_RATES_ENV]: '{"health":0.25}',
    });
    const first = resolveUsageSampleRate(env, {
      route: "health",
      ok: true,
      durationMs: 1,
    });
    const second = resolveUsageSampleRate(env, {
      route: "health",
      ok: true,
      durationMs: 1,
    });
    assert.equal(first, 0.25);
    assert.equal(second, 0.25);
  });

  test("a sampled-out event never reaches the capture endpoint", async () => {
    const calls: Row[] = [];
    const recorded = await recordUsageEvent(
      mockEnv({ ...token, [POSTHOG_USAGE_SAMPLE_RATE_ENV]: "0.2" }),
      { route: "block-detail", ok: true, durationMs: 5 },
      {
        fetch: fakeFetch({ onCall: (call) => calls.push(call) }),
        random: () => 0.9,
      },
    );
    assert.equal(recorded, false);
    assert.equal(calls.length, 0);
  });

  test("a sampled-in event carries its weight so counts can be scaled back up", async () => {
    const calls: Row[] = [];
    const recorded = await recordUsageEvent(
      mockEnv({ ...token, [POSTHOG_USAGE_SAMPLE_RATE_ENV]: "0.2" }),
      { route: "block-detail", ok: true, durationMs: 5 },
      {
        fetch: fakeFetch({ onCall: (call) => calls.push(call) }),
        random: () => 0.1,
      },
    );
    assert.equal(recorded, true);
    assert.equal(calls.length, 1);
    assert.equal((calls[0].body as Row).properties.sample_rate, 0.2);
  });

  test("an unsampled event omits sample_rate entirely", async () => {
    const calls: Row[] = [];
    await recordUsageEvent(
      mockEnv(token),
      { route: "block-detail", ok: true, durationMs: 5 },
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    assert.equal(calls.length, 1);
    assert.equal(
      "sample_rate" in (calls[0].body as Row).properties,
      false,
      "no sample_rate keeps every pre-existing dashboard query correct",
    );
  });

  test("without an injected source the gate uses Math.random", async () => {
    const calls: Row[] = [];
    const realRandom = Math.random;
    let used = false;
    Math.random = () => {
      used = true;
      return 0.05;
    };
    try {
      const recorded = await recordUsageEvent(
        mockEnv({ ...token, [POSTHOG_USAGE_SAMPLE_RATE_ENV]: "0.2" }),
        { route: "block-detail", ok: true, durationMs: 5 },
        { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
      );
      assert.equal(used, true, "the real Math.random is the default source");
      assert.equal(recorded, true);
      assert.equal((calls[0].body as Row).properties.sample_rate, 0.2);
    } finally {
      Math.random = realRandom;
    }
  });

  test("a malformed event is still rejected as malformed, never as sampled-out", async () => {
    const calls: Row[] = [];
    const recorded = await recordUsageEvent(
      mockEnv({ ...token, [POSTHOG_USAGE_SAMPLE_RATE_ENV]: "0.2" }),
      { route: "block-detail", durationMs: 5 } as never,
      {
        fetch: fakeFetch({ onCall: (call) => calls.push(call) }),
        random: () => 0.01,
      },
    );
    assert.equal(recorded, false);
    assert.equal(calls.length, 0);
  });
});

// #9430: the deployment dimensions. Every event this module emits was
// previously indistinguishable from every other deployment's, so a local
// `wrangler dev` isolate captured into the same PostHog project as production
// with nothing on the wire to separate them.
describe("resolveDeployment", () => {
  test("development when the version-metadata binding is absent", () => {
    assert.deepEqual(resolveDeployment(mockEnv()), {
      environment: "development",
    });
    assert.deepEqual(resolveDeployment(undefined), {
      environment: "development",
    });
  });

  test("development when the binding is present but carries no id", () => {
    assert.deepEqual(resolveDeployment(mockEnv({ CF_VERSION_METADATA: {} })), {
      environment: "development",
    });
    assert.deepEqual(
      resolveDeployment(mockEnv({ CF_VERSION_METADATA: { id: "   " } })),
      { environment: "development" },
    );
  });

  test("production with the id as release when no tag is set", () => {
    assert.deepEqual(
      resolveDeployment(
        mockEnv({ CF_VERSION_METADATA: { id: "abc-123", tag: "" } }),
      ),
      { environment: "production", release: "abc-123" },
    );
  });

  test("prefers the human-meaningful tag over the UUID id", () => {
    assert.deepEqual(
      resolveDeployment(
        mockEnv({ CF_VERSION_METADATA: { id: "abc-123", tag: "v2026.08.04" } }),
      ),
      { environment: "production", release: "v2026.08.04" },
    );
  });

  test("stamps environment and release onto a usage_event", async () => {
    const calls: Row[] = [];
    await recordUsageEvent(
      mockEnv({
        [POSTHOG_PROJECT_TOKEN_ENV]: "phc_token",
        CF_VERSION_METADATA: { id: "dep-1", tag: "v9" },
      }),
      { route: "subnets", ok: true, durationMs: 3 },
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    const properties = (calls[0].body as Row).properties;
    assert.equal(properties.environment, "production");
    assert.equal(properties.release, "v9");
    // PostHog Error Tracking reads its own release field; both come from one
    // resolution so a release filter behaves identically on either event.
    assert.deepEqual(properties.$exception_releases, ["v9"]);
  });

  test("stamps environment and release onto an $exception", async () => {
    const calls: Row[] = [];
    await recordExceptionEvent(
      mockEnv({
        [POSTHOG_PROJECT_TOKEN_ENV]: "phc_token",
        CF_VERSION_METADATA: { id: "dep-2" },
      }),
      { error: new Error("boom"), route: "subnets" },
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    const properties = (calls[0].body as Row).properties;
    assert.equal(properties.environment, "production");
    assert.equal(properties.release, "dep-2");
  });

  test("omits release entirely off a real deployment", async () => {
    const calls: Row[] = [];
    await recordUsageEvent(
      mockEnv({ [POSTHOG_PROJECT_TOKEN_ENV]: "phc_token" }),
      { route: "subnets", ok: true, durationMs: 3 },
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    const properties = (calls[0].body as Row).properties;
    assert.equal(properties.environment, "development");
    assert.equal("release" in properties, false);
    assert.equal("$exception_releases" in properties, false);
  });
});

// #9430: the $exception storm guard. `wallet-auth-keys` captured 871,649
// events in four days against a 1M/MONTH tier -- one Issue, 87% of the
// allowance, one occurrence per request -- and because exhausting the tier
// drops events indiscriminately, it took the error inbox down with it.
describe("admitExceptionCapture", () => {
  const windowed = (ms: string) =>
    mockEnv({
      [POSTHOG_PROJECT_TOKEN_ENV]: "phc_token",
      [POSTHOG_EXCEPTION_STORM_WINDOW_MS_ENV]: ms,
    });

  test("admits everything when the window is unset — the default", () => {
    const env = mockEnv({ [POSTHOG_PROJECT_TOKEN_ENV]: "phc_token" });
    assert.equal(admitExceptionCapture(env, "route:Error", 0), 0);
    assert.equal(admitExceptionCapture(env, "route:Error", 1), 0);
    assert.equal(admitExceptionCapture(env, "route:Error", 2), 0);
  });

  test("a blank, zero, negative or malformed window disables the guard", () => {
    for (const value of ["", "   ", "0", "-1", "abc"]) {
      const env = windowed(value);
      assert.equal(admitExceptionCapture(env, `k-${value}:Error`, 0), 0);
      assert.equal(admitExceptionCapture(env, `k-${value}:Error`, 1), 0);
    }
  });

  test("admits the first occurrence and throttles the rest of the window", () => {
    const env = windowed("60000");
    assert.equal(admitExceptionCapture(env, "a:Error", 1_000), 0);
    assert.equal(admitExceptionCapture(env, "a:Error", 2_000), null);
    assert.equal(admitExceptionCapture(env, "a:Error", 60_000), null);
  });

  test("reports how many it suppressed on the next admitted capture", () => {
    const env = windowed("60000");
    assert.equal(admitExceptionCapture(env, "b:Error", 0), 0);
    for (let i = 1; i <= 5; i += 1) {
      assert.equal(admitExceptionCapture(env, "b:Error", i), null);
    }
    // The window elapsed: the next one is admitted and carries the 5 it stood
    // in for, so a storm's VOLUME survives the throttling that caps its cost.
    assert.equal(admitExceptionCapture(env, "b:Error", 60_001), 5);
    // ...and the counter resets with the new window.
    assert.equal(admitExceptionCapture(env, "b:Error", 120_002), 0);
  });

  test("throttles per fingerprint, so a second fault is never masked", () => {
    const env = windowed("60000");
    assert.equal(admitExceptionCapture(env, "c:Error", 0), 0);
    assert.equal(admitExceptionCapture(env, "c:Error", 1), null);
    // A DIFFERENT route+type is a different diagnosis and must report
    // immediately — the failure mode that makes a permanent per-isolate
    // suppression (data-api's schema-drift set) wrong for the general case.
    assert.equal(admitExceptionCapture(env, "d:TypeError", 2), 0);
  });

  test("suppresses the duplicate capture end-to-end, and says so on resume", async () => {
    const calls: Row[] = [];
    const env = windowed("60000");
    const fetchImpl = fakeFetch({ onCall: (call) => calls.push(call) });
    const event = { error: new Error("boom"), route: "storm" };

    assert.equal(
      await recordExceptionEvent(env, event, { fetch: fetchImpl }),
      true,
    );
    // Same route + same error type = same PostHog Issue, so the second adds
    // no diagnosis. Reported as not-recorded, exactly like a sampled-out
    // usage_event.
    assert.equal(
      await recordExceptionEvent(env, event, { fetch: fetchImpl }),
      false,
    );
    assert.equal(calls.length, 1);
    assert.equal(
      "suppressed_occurrences" in (calls[0].body as Row).properties,
      false,
      "the ordinary case keeps its exact pre-existing payload",
    );
  });
});

// #9430: the MCP surface is never sampled — the whole surface, not just the
// one event that happens to carry a tool name.
describe("MCP protocol events are exempt from usage_event sampling", () => {
  const sampled = {
    [POSTHOG_PROJECT_TOKEN_ENV]: "phc_token",
    [POSTHOG_USAGE_SAMPLE_RATE_ENV]: "0.05",
  };

  test("every mcp: protocol route resolves to rate 1", () => {
    // scheduleMcpProtocolUsageEvent (src/mcp-server.ts) sets `route` and never
    // `mcpTool`, so the pre-existing mcpTool exemption did not cover these and
    // 95% of them were dropped.
    for (const method of [
      "ping",
      "resources/read",
      "resources/subscribe",
      "prompts/get",
      "notifications/initialized",
      "unknown",
    ]) {
      assert.equal(
        resolveUsageSampleRate(mockEnv(sampled), {
          route: `${MCP_PROTOCOL_ROUTE_PREFIX}${method}`,
          ok: true,
          durationMs: 1,
        }),
        1,
        `mcp:${method} must not be sampled`,
      );
    }
  });

  test("a per-route override cannot re-sample the MCP surface", () => {
    assert.equal(
      resolveUsageSampleRate(
        mockEnv({
          ...sampled,
          [POSTHOG_USAGE_SAMPLE_RATES_ENV]: '{"mcp:ping":0.01}',
        }),
        { route: "mcp:ping", ok: true, durationMs: 1 },
      ),
      1,
    );
  });

  test("a REST route that merely CONTAINS mcp is still sampled", () => {
    // The exemption is a namespace prefix, not a substring match — a route
    // label like `subnet-mcp:detail` is REST traffic and must keep its rate.
    assert.equal(
      resolveUsageSampleRate(mockEnv(sampled), {
        route: "subnet-mcp:detail",
        ok: true,
        durationMs: 1,
      }),
      0.05,
    );
  });

  test("captures an mcp: event that a 0.05 rate would otherwise have dropped", async () => {
    const calls: Row[] = [];
    const recorded = await recordUsageEvent(
      mockEnv(sampled),
      { route: "mcp:ping", ok: true, durationMs: 2 },
      {
        fetch: fakeFetch({ onCall: (call) => calls.push(call) }),
        // Above 0.05: this event would be sampled out if the gate applied.
        random: () => 0.99,
      },
    );
    assert.equal(recorded, true);
    assert.equal(calls.length, 1);
    // Unsampled captures omit sample_rate entirely, so a weighted aggregate
    // (sum(1/coalesce(sample_rate,1))) counts them exactly once.
    assert.equal("sample_rate" in (calls[0].body as Row).properties, false);
  });
});

// #9446: EVERY capture this module posts carries the deployment dimensions.
//
// #9434 added them by editing two recorders, which is how the other six
// shipped without: a live query showed usage_event and $exception tagged
// `production` with a real release id while every $mcp_* event carried null.
// The dimension is only useful if it is on all of them -- a breakdown by
// environment silently drops whichever family forgot.
//
// Written as one table over the whole family rather than six separate
// assertions so a NEWLY ADDED recorder that forgets is a failing test here,
// not a gap discovered months later in production data.
describe("every recorder stamps the deployment dimensions", () => {
  const DEPLOYED = {
    [POSTHOG_PROJECT_TOKEN_ENV]: "phc_token",
    CF_VERSION_METADATA: { id: "dep-9", tag: "v9" },
  };

  // Typed against the recorders' real signatures rather than Row, so the
  // table cannot drift from what they actually accept.
  const recorders: Array<
    [string, (env: Env, deps: RecordUsageEventDeps) => Promise<unknown>]
  > = [
    [
      "usage_event",
      (env, deps) =>
        recordUsageEvent(env, { route: "r", ok: true, durationMs: 1 }, deps),
    ],
    [
      "$exception",
      (env, deps) =>
        recordExceptionEvent(env, { error: new Error("x"), route: "r" }, deps),
    ],
    [
      "$mcp_tool_call",
      (env, deps) =>
        recordMcpToolCallEvent(
          env,
          { toolName: "get_subnet", isError: false, durationMs: 5 },
          deps,
        ),
    ],
    [
      "$mcp_initialize",
      (env, deps) => recordMcpInitializeEvent(env, { clientName: "c" }, deps),
    ],
    [
      "$mcp_tools_list",
      (env, deps) => recordMcpToolsListEvent(env, { toolCount: 3 }, deps),
    ],
    [
      "ai_degraded",
      (env, deps) =>
        recordAiDegradedEvent(env, { reason: "ai_disabled" }, deps),
    ],
    [
      "$ai_embedding",
      (env, deps) =>
        recordAiEmbeddingEvent(
          env,
          { provider: "p", model: "m", latencyMs: 1, isError: false },
          deps,
        ),
    ],
    [
      "$ai_generation",
      (env, deps) =>
        recordAiGenerationEvent(
          env,
          { provider: "p", model: "m", latencyMs: 1, isError: false },
          deps,
        ),
    ],
  ];

  for (const [eventName, invoke] of recorders) {
    test(`${eventName} carries environment and release`, async () => {
      const calls: Row[] = [];
      await invoke(mockEnv(DEPLOYED), {
        fetch: fakeFetch({ onCall: (call) => calls.push(call) }),
      });

      assert.equal(calls.length, 1, "the recorder posted nothing");
      assert.equal((calls[0].body as Row).event, eventName);
      const properties = (calls[0].body as Row).properties as Row;
      assert.equal(properties.environment, "production");
      assert.equal(properties.release, "v9");
    });
  }

  test("the table covers every exported recorder in this module", async () => {
    // The assertion that makes the table self-maintaining: a new recordX
    // export that is not listed above fails HERE, rather than shipping a
    // family with no environment on it. Reads the module's own exports, so it
    // cannot drift from what actually exists.
    const module = (await import("../src/usage-telemetry.ts")) as Record<
      string,
      unknown
    >;
    const exported = Object.keys(module)
      .filter((name) => /^record[A-Z]/.test(name))
      .sort();
    assert.equal(
      exported.length,
      recorders.length,
      `recorders covered: ${recorders.length}, exported: ${exported.join(", ")}`,
    );
  });
});
