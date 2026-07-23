import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  POSTHOG_CAPTURE_PATH,
  POSTHOG_HOST_ENV,
  POSTHOG_PROJECT_TOKEN_ENV,
  USAGE_EVENT_DISTINCT_ID,
  USAGE_EVENT_NAME,
  isUsageTelemetryConfigured,
  recordMcpInitializeEvent,
  recordMcpToolCallEvent,
  recordUsageEvent,
  resolvePostHogHost,
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

// #7737: recordMcpToolCallEvent is the one place $mcp_parameters/$mcp_response
// get built — there is no SDK instrument() pipeline redacting these for us
// (see the module's own header comment), so this redaction is the only thing
// standing between a real credential and PostHog.
describe("recordMcpToolCallEvent", () => {
  const CONFIGURED = { [POSTHOG_PROJECT_TOKEN_ENV]: "phc_token" };

  test("posts $mcp_tool_call with tool name / error flag / duration / session id", async () => {
    const calls = [];
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
        { isError: "yes", durationMs: 1 },
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
    const calls = [];
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
    const calls = [];
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
    const calls = [];
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
    const circular = {};
    circular.self = circular;
    const calls = [];
    const recorded = await recordMcpToolCallEvent(
      CONFIGURED,
      { isError: false, durationMs: 1, response: circular },
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    assert.equal(recorded, true);
    assert.ok(calls[0].body.properties.$mcp_response !== undefined);
  });

  test("omits $mcp_parameters / $mcp_response entirely when not supplied", async () => {
    const calls = [];
    await recordMcpToolCallEvent(
      CONFIGURED,
      { isError: false, durationMs: 1 },
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    assert.equal("$mcp_parameters" in calls[0].body.properties, false);
    assert.equal("$mcp_response" in calls[0].body.properties, false);
  });

  test("redacts a string credential (bearer/api-key/basic shape) out of $mcp_parameters", async () => {
    const calls = [];
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
    const calls = [];
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
    const calls = [];
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
    const calls = [];
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
    const calls = [];
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
    const calls = [];
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
    let deep = { credential: "leaf-secret" };
    for (let i = 0; i < 50; i += 1) deep = { nested: deep };
    const calls = [];
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
      {},
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
  const CONFIGURED = { [POSTHOG_PROJECT_TOKEN_ENV]: "phc_token" };

  test("posts $mcp_initialize with client name / version / session id", async () => {
    const calls = [];
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
      $mcp_client_version: "1.2.3",
      $session_id: "sess-1",
    });
  });

  test("omits client name / version / session id when blank or absent", async () => {
    const calls = [];
    await recordMcpInitializeEvent(
      CONFIGURED,
      {},
      { fetch: fakeFetch({ onCall: (call) => calls.push(call) }) },
    );
    assert.deepEqual(calls[0].body.properties, {});
  });

  test("defaults to the platform fetch when none is injected", async () => {
    const original = globalThis.fetch;
    const calls = [];
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
      {},
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
