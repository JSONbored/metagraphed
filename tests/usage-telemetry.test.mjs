import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  MCP_INITIALIZE_EVENT,
  MCP_REDACTED_PLACEHOLDER,
  MCP_TOOL_CALL_EVENT,
  POSTHOG_CAPTURE_PATH,
  POSTHOG_HOST_ENV,
  POSTHOG_PROJECT_TOKEN_ENV,
  USAGE_EVENT_DISTINCT_ID,
  USAGE_EVENT_NAME,
  captureSafeMcpPayload,
  isSensitiveMcpKey,
  isUsageTelemetryConfigured,
  mcpInitializeProperties,
  mcpToolCallProperties,
  recordMcpAnalyticsEvent,
  recordMcpInitializeEvent,
  recordMcpToolCallEvent,
  recordUsageEvent,
  resolvePostHogHost,
  sanitizeMcpPayload,
  usageEventProperties,
} from "../src/usage-telemetry.ts";

// A capture is one POST — record what it was handed, and let a test choose the
// outcome (accepted, rejected, transport failure).
function fakeFetch({ onCall, ok = true, throws = false, response } = {}) {
  return async (url, init) => {
    if (throws) throw new Error("network unreachable");
    onCall?.({ url, init, body: JSON.parse(init.body) });
    return response === undefined ? { ok } : response;
  };
}

describe("isUsageTelemetryConfigured", () => {
  test("false when env is missing / token empty / whitespace", () => {
    assert.equal(isUsageTelemetryConfigured(undefined), false);
    assert.equal(isUsageTelemetryConfigured({}), false);
    assert.equal(
      isUsageTelemetryConfigured({ [POSTHOG_PROJECT_TOKEN_ENV]: "" }),
      false,
    );
    assert.equal(
      isUsageTelemetryConfigured({ [POSTHOG_PROJECT_TOKEN_ENV]: "   " }),
      false,
    );
    assert.equal(
      isUsageTelemetryConfigured({ [POSTHOG_PROJECT_TOKEN_ENV]: 123 }),
      false,
    );
  });

  test("true when a non-empty token string is set", () => {
    assert.equal(
      isUsageTelemetryConfigured({
        [POSTHOG_PROJECT_TOKEN_ENV]: "phc_test_token",
      }),
      true,
    );
  });
});

describe("usageEventProperties", () => {
  test("returns null for missing ok or non-finite / negative duration", () => {
    assert.equal(usageEventProperties(null), null);
    assert.equal(usageEventProperties({ durationMs: 10 }), null);
    assert.equal(usageEventProperties({ ok: true }), null);
    assert.equal(
      usageEventProperties({ ok: true, durationMs: Number.NaN }),
      null,
    );
    assert.equal(usageEventProperties({ ok: true, durationMs: -1 }), null);
    assert.equal(usageEventProperties({ ok: "yes", durationMs: 10 }), null);
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
      }),
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
    // mcp-server.mjs's callTool enforces that contract at the call site).
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
      usageEventProperties({ ok: true, durationMs: 999_999_999 }).duration_ms,
      86_400_000,
    );
  });
});

describe("resolvePostHogHost", () => {
  test("resolvePostHogHost trims a custom host or falls back to US cloud", () => {
    assert.equal(resolvePostHogHost(undefined), "https://us.i.posthog.com");
    assert.equal(
      resolvePostHogHost({ [POSTHOG_HOST_ENV]: "  https://eu.i.posthog.com " }),
      "https://eu.i.posthog.com",
    );
    assert.equal(
      resolvePostHogHost({ [POSTHOG_HOST_ENV]: "   " }),
      "https://us.i.posthog.com",
    );
  });
});

describe("recordUsageEvent — unconfigured (safe no-op)", () => {
  test("returns false and never issues a capture", async () => {
    let calls = 0;
    const recorded = await recordUsageEvent(
      {},
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
    const calls = [];
    const env = {
      [POSTHOG_PROJECT_TOKEN_ENV]: " phc_token ",
      [POSTHOG_HOST_ENV]: "https://eu.i.posthog.com",
    };

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
      },
    });
  });

  test("defaults host to PostHog US cloud when POSTHOG_HOST is unset", async () => {
    const calls = [];
    await recordUsageEvent(
      { [POSTHOG_PROJECT_TOKEN_ENV]: "phc_token" },
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
    const calls = [];
    globalThis.fetch = fakeFetch({ onCall: (call) => calls.push(call) });
    try {
      const recorded = await recordUsageEvent(
        { [POSTHOG_PROJECT_TOKEN_ENV]: "phc_token" },
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
      { [POSTHOG_PROJECT_TOKEN_ENV]: "phc_token" },
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
      { [POSTHOG_PROJECT_TOKEN_ENV]: "phc_token" },
      { ok: true, durationMs: 3 },
      { fetch: fakeFetch({ throws: true }) },
    );
    assert.equal(recorded, false);
  });

  test("reports a rejected capture as not recorded", async () => {
    const recorded = await recordUsageEvent(
      { [POSTHOG_PROJECT_TOKEN_ENV]: "phc_token" },
      { mcpTool: "list_tools", ok: true, durationMs: 9 },
      { fetch: fakeFetch({ ok: false }) },
    );
    assert.equal(recorded, false);
  });

  test("reports a missing response as not recorded", async () => {
    const recorded = await recordUsageEvent(
      { [POSTHOG_PROJECT_TOKEN_ENV]: "phc_token" },
      { ok: true, durationMs: 9 },
      { fetch: fakeFetch({ response: null }) },
    );
    assert.equal(recorded, false);
  });

  test("honors an injected distinctId override", async () => {
    const calls = [];
    await recordUsageEvent(
      { [POSTHOG_PROJECT_TOKEN_ENV]: "phc_token" },
      { ok: true, durationMs: 2 },
      {
        distinctId: "test-distinct",
        fetch: fakeFetch({ onCall: (call) => calls.push(call) }),
      },
    );
    assert.equal(calls[0].body.distinct_id, "test-distinct");
  });
});

describe("sanitizeMcpPayload / captureSafeMcpPayload (#7737)", () => {
  test("isSensitiveMcpKey matches the issue's key set case-insensitively", () => {
    assert.equal(isSensitiveMcpKey("credential"), true);
    assert.equal(isSensitiveMcpKey("Owner_Token"), true);
    assert.equal(isSensitiveMcpKey("AUTHORIZATION"), true);
    assert.equal(isSensitiveMcpKey("api_key"), true);
    assert.equal(isSensitiveMcpKey("private_key"), true);
    assert.equal(isSensitiveMcpKey("surface_id"), false);
    assert.equal(isSensitiveMcpKey(null), false);
  });

  test("redacts sensitive keys recursively without descending into them", () => {
    const out = sanitizeMcpPayload({
      surface_id: "x:api:1",
      credential: {
        name: "Authorization",
        value: "Bearer super-secret-token-value",
        location: "header",
      },
      nested: {
        owner_token: "owner-secret",
        password: "hunter2",
        cookie: "sid=abc",
        token: "tok",
        secret: "shh",
        api_key: "ak",
        private_key: "pk",
        authorization: "Basic xxx",
        safe: "ok",
      },
    });
    assert.equal(out.surface_id, "x:api:1");
    assert.equal(out.credential, MCP_REDACTED_PLACEHOLDER);
    assert.equal(out.nested.owner_token, MCP_REDACTED_PLACEHOLDER);
    assert.equal(out.nested.password, MCP_REDACTED_PLACEHOLDER);
    assert.equal(out.nested.cookie, MCP_REDACTED_PLACEHOLDER);
    assert.equal(out.nested.token, MCP_REDACTED_PLACEHOLDER);
    assert.equal(out.nested.secret, MCP_REDACTED_PLACEHOLDER);
    assert.equal(out.nested.api_key, MCP_REDACTED_PLACEHOLDER);
    assert.equal(out.nested.private_key, MCP_REDACTED_PLACEHOLDER);
    assert.equal(out.nested.authorization, MCP_REDACTED_PLACEHOLDER);
    assert.equal(out.nested.safe, "ok");
    // Raw secret must not appear anywhere in the sanitized tree.
    assert.equal(
      JSON.stringify(out).includes("super-secret-token-value"),
      false,
    );
    assert.equal(JSON.stringify(out).includes("owner-secret"), false);
    assert.equal(JSON.stringify(out).includes("hunter2"), false);
  });

  test("truncates overlong strings and deep trees", () => {
    const long = "y".repeat(9_000);
    assert.match(sanitizeMcpPayload(long), /\[truncated\]$/);

    let deep = { leaf: "ok" };
    for (let i = 0; i < 20; i += 1) deep = { child: deep };
    const capped = sanitizeMcpPayload(deep);
    assert.match(JSON.stringify(capped), /max_depth/);
  });

  test("truncates array and object breadth, and stringifies exotic values", () => {
    const wideArray = Array.from({ length: 105 }, (_, i) => i);
    const arrayOut = sanitizeMcpPayload(wideArray);
    assert.equal(arrayOut.length, 101);
    assert.match(arrayOut[100], /_more\]$/);

    const wideObject = Object.fromEntries(
      Array.from({ length: 105 }, (_, i) => [`k${i}`, i]),
    );
    const objectOut = sanitizeMcpPayload(wideObject);
    assert.equal(objectOut["…"].includes("_more"), true);
    assert.equal(Object.keys(objectOut).length, 101);

    assert.equal(sanitizeMcpPayload(Number.POSITIVE_INFINITY), "Infinity");
    assert.equal(sanitizeMcpPayload(undefined), undefined);
    assert.equal(sanitizeMcpPayload(null), null);
    assert.equal(sanitizeMcpPayload(true), true);
    assert.equal(sanitizeMcpPayload(123n), "123");
  });

  test("sanitizeMcpPayload returns unserializable when walking throws", () => {
    const evil = {};
    Object.defineProperty(evil, "x", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });
    assert.equal(sanitizeMcpPayload(evil), "[unserializable]");
  });

  test("captureSafeMcpPayload collapses an oversized serialized body", () => {
    // 100 breadth-capped strings near the per-string cap exceed the total
    // serialized budget even after sanitizeMcpPayload runs.
    const huge = {
      rows: Array.from({ length: 100 }, () => "x".repeat(8_000)),
    };
    const out = captureSafeMcpPayload(huge);
    assert.equal(out.truncated, true);
    assert.equal(typeof out.preview, "string");
  });

  test("captureSafeMcpPayload returns unserializable when JSON.stringify throws", () => {
    const cyclic = {};
    cyclic.self = cyclic;
    // sanitizeMcpPayload walks plain objects and will recurse into the cycle
    // until max_depth, so build a value whose sanitized form still throws:
    // BigInt is preserved only via String() path; use a toJSON bomb instead.
    const bomb = {
      toJSON() {
        throw new Error("nope");
      },
    };
    // sanitize copies enumerable own props; toJSON isn't copied as a value
    // that JSON.stringify will call unless we keep the object identity. Force
    // the catch by stubbing JSON.stringify once.
    const original = JSON.stringify;
    JSON.stringify = () => {
      throw new Error("stringify failed");
    };
    try {
      assert.equal(captureSafeMcpPayload({ a: 1 }), "[unserializable]");
    } finally {
      JSON.stringify = original;
    }
    assert.equal(typeof cyclic.self, "object");
    assert.equal(typeof bomb.toJSON, "function");
  });
});

describe("mcpInitializeProperties / mcpToolCallProperties (#7737)", () => {
  test("mcpInitializeProperties requires server identity", () => {
    assert.equal(mcpInitializeProperties(null), null);
    assert.equal(mcpInitializeProperties({ serverName: "x" }), null);
    assert.deepEqual(
      mcpInitializeProperties({
        clientName: " cursor ",
        clientVersion: "1.0",
        serverName: "metagraphed",
        serverVersion: "1.2.3",
        sessionId: "sess-1",
      }),
      {
        $mcp_server_name: "metagraphed",
        $mcp_server_version: "1.2.3",
        $mcp_client_name: "cursor",
        $mcp_client_version: "1.0",
        $session_id: "sess-1",
        $process_person_profile: false,
      },
    );
  });

  test("mcpToolCallProperties redacts credentials in parameters and response", () => {
    const props = mcpToolCallProperties({
      toolName: "call_subnet_surface",
      toolDescription: "Execute a registered surface",
      parameters: {
        surface_id: "x:api:1",
        credential: { value: "Bearer leak-me-now" },
      },
      response: {
        isError: false,
        structuredContent: { ok: true, echo: { password: "nope" } },
      },
      durationMs: 12.4,
      isError: false,
    });
    assert.equal(props.$mcp_tool_name, "call_subnet_surface");
    assert.equal(props.$mcp_is_error, false);
    assert.equal(props.$mcp_duration_ms, 12);
    assert.equal(props.$mcp_parameters.credential, MCP_REDACTED_PLACEHOLDER);
    assert.equal(props.$mcp_parameters.surface_id, "x:api:1");
    assert.equal(
      props.$mcp_response.structuredContent.echo.password,
      MCP_REDACTED_PLACEHOLDER,
    );
    const wire = JSON.stringify(props);
    assert.equal(wire.includes("leak-me-now"), false);
    assert.equal(wire.includes("Bearer"), false);
    assert.equal(wire.includes("nope"), false);
    assert.equal("$mcp_error_type" in props, false);
  });

  test("mcpToolCallProperties rejects malformed events", () => {
    assert.equal(mcpToolCallProperties(null), null);
    assert.equal(
      mcpToolCallProperties({ toolName: "   ", durationMs: 1, isError: false }),
      null,
    );
    assert.equal(mcpToolCallProperties({ toolName: "x", durationMs: 1 }), null);
    assert.equal(
      mcpToolCallProperties({
        toolName: "x",
        durationMs: Number.NaN,
        isError: false,
      }),
      null,
    );
    assert.equal(
      mcpToolCallProperties({
        toolName: "x",
        durationMs: -1,
        isError: false,
      }),
      null,
    );
  });

  test("mcpToolCallProperties omits blank error types and optional fields", () => {
    const props = mcpToolCallProperties({
      toolName: "get_subnet",
      durationMs: 2,
      isError: true,
      errorType: "   ",
    });
    assert.equal(props.$mcp_is_error, true);
    assert.equal("$mcp_error_type" in props, false);
    assert.equal("$mcp_tool_description" in props, false);
    assert.equal("$session_id" in props, false);
    assert.deepEqual(props.$mcp_parameters, {});
    assert.equal(props.$mcp_response, null);
  });

  test("mcpToolCallProperties includes error type only on failures", () => {
    const props = mcpToolCallProperties({
      toolName: "get_subnet",
      parameters: {},
      response: { isError: true },
      durationMs: 1,
      isError: true,
      errorType: "invalid_params",
      sessionId: "sess-9",
      toolDescription: "Get one subnet",
    });
    assert.equal(props.$mcp_error_type, "invalid_params");
    assert.equal(props.$session_id, "sess-9");
    assert.equal(props.$mcp_tool_description, "Get one subnet");
  });
});

describe("recordMcpAnalyticsEvent (#7737)", () => {
  test("posts $mcp_initialize and $mcp_tool_call with redacted properties", async () => {
    const calls = [];
    const env = { [POSTHOG_PROJECT_TOKEN_ENV]: "phc_token" };
    const fetch = fakeFetch({ onCall: (call) => calls.push(call) });

    assert.equal(
      await recordMcpInitializeEvent(
        env,
        {
          serverName: "metagraphed",
          serverVersion: "9.9.9",
          clientName: "test",
        },
        { fetch },
      ),
      true,
    );
    assert.equal(
      await recordMcpToolCallEvent(
        env,
        {
          toolName: "call_subnet_surface",
          parameters: { credential: "SECRET_VALUE_XYZ" },
          response: { ok: true },
          durationMs: 3,
          isError: false,
        },
        { fetch },
      ),
      true,
    );

    assert.equal(calls.length, 2);
    assert.equal(calls[0].body.event, MCP_INITIALIZE_EVENT);
    assert.equal(calls[1].body.event, MCP_TOOL_CALL_EVENT);
    assert.equal(
      calls[1].body.properties.$mcp_parameters.credential,
      MCP_REDACTED_PLACEHOLDER,
    );
    assert.equal(
      JSON.stringify(calls[1].body).includes("SECRET_VALUE_XYZ"),
      false,
    );
  });

  test("rejects unknown event names, bad properties, and unconfigured env", async () => {
    let calls = 0;
    const fetch = fakeFetch({
      onCall: () => {
        calls += 1;
      },
    });
    assert.equal(
      await recordMcpAnalyticsEvent(
        { [POSTHOG_PROJECT_TOKEN_ENV]: "phc" },
        "$mcp_tools_list",
        { a: 1 },
        { fetch },
      ),
      false,
    );
    assert.equal(
      await recordMcpAnalyticsEvent(
        { [POSTHOG_PROJECT_TOKEN_ENV]: "phc" },
        MCP_TOOL_CALL_EVENT,
        null,
        { fetch },
      ),
      false,
    );
    assert.equal(
      await recordMcpToolCallEvent(
        {},
        {
          toolName: "x",
          durationMs: 1,
          isError: false,
        },
        { fetch },
      ),
      false,
    );
    assert.equal(
      await recordMcpToolCallEvent(
        { [POSTHOG_PROJECT_TOKEN_ENV]: "phc" },
        { toolName: "x", durationMs: -5, isError: false },
        { fetch },
      ),
      false,
    );
    assert.equal(calls, 0);
  });

  test("swallows transport failures and rejected captures", async () => {
    assert.equal(
      await recordMcpInitializeEvent(
        { [POSTHOG_PROJECT_TOKEN_ENV]: "phc" },
        { serverName: "metagraphed", serverVersion: "1" },
        { fetch: fakeFetch({ throws: true }) },
      ),
      false,
    );
    assert.equal(
      await recordMcpInitializeEvent(
        { [POSTHOG_PROJECT_TOKEN_ENV]: "phc" },
        { serverName: "metagraphed", serverVersion: "1" },
        { fetch: fakeFetch({ ok: false }) },
      ),
      false,
    );
  });

  test("defaults to platform fetch and honors distinctId", async () => {
    const original = globalThis.fetch;
    const calls = [];
    globalThis.fetch = fakeFetch({ onCall: (call) => calls.push(call) });
    try {
      assert.equal(
        await recordMcpInitializeEvent(
          { [POSTHOG_PROJECT_TOKEN_ENV]: "phc" },
          { serverName: "metagraphed", serverVersion: "1" },
          { distinctId: "mcp-distinct" },
        ),
        true,
      );
      assert.equal(calls.length, 1);
      assert.equal(calls[0].body.distinct_id, "mcp-distinct");
      assert.equal(calls[0].body.event, MCP_INITIALIZE_EVENT);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("recordMcpInitializeEvent returns false when identity is blank", async () => {
    let calls = 0;
    assert.equal(
      await recordMcpInitializeEvent(
        { [POSTHOG_PROJECT_TOKEN_ENV]: "phc" },
        { serverName: "  ", serverVersion: "1" },
        {
          fetch: fakeFetch({
            onCall: () => {
              calls += 1;
            },
          }),
        },
      ),
      false,
    );
    assert.equal(calls, 0);
  });
});
